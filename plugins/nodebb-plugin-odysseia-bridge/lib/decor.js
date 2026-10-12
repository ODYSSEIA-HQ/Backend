'use strict';

/**
 * ΟΔΥΣΣΕΙΑ 身分组装饰引擎（服务端）
 *
 * 职责（纯库、零 hook 注册 —— 解耦点：library.js 只做接线，本模块不感知 hook 体系）：
 *   1. 装饰规则配置的读取 / 消毒 / 缓存（存储：meta.settings hash = 'odysseia-decor'）
 *   2. 批量为用户解析装饰数据（badge pill + 用户名特效），供楼层 / profile / 聊天室统一消费
 *
 * 数据流（前端消费方，见 static/lib/decor.js）：
 *   - 楼层 SSR/API：filter:posts.getUserInfoForPosts → user.odyDecor
 *   - profile：filter:helpers.getUserDataByUserSlug → userData.odyDecor
 *   - 聊天室实时消息：onPostSave 广播 payload 附 decor 字段
 *
 * 性能护栏：
 *   - 无规则 / 未启用 → 全链路零查询短路
 *   - 规则缓存（含组元数据快照，TTL 兜底 + 显式失效双通道）
 *   - 成员判定按「规则组数」批量（Groups.isMembers(uids, name)），
 *     查询次数与页面楼层人数无关；badge 顺序按规则 priority 降序
 *
 * 规则 schema（ACP 可视化编辑，见 acpTemplates/admin/plugins/odysseia-decor.tpl）：
 *   { groupName, enabled, priority,
 *     badge: { enabled, label, icon, color, textColor, gradient, glow, className },
 *     name:  { enabled, gradient, color, glow, bold, className },
 *     custom: { 任意 string→string，预留花样出口 } }
 */

const SETTINGS_KEY = 'odysseia-decor';
const CACHE_TTL_MS = 5 * 60 * 1000; // 组元数据快照 TTL（settings/group 变更时显式失效）

/** 防御式加载 NodeBB 内部模块（4.x 模块路径以 src/ 为准） */
function loadModule(...paths) {
	for (const p of paths) {
		try {
			return require.main.require(p);
		} catch (e) {
			/* 尝试下一个路径 */
		}
	}
	return null;
}

const meta = loadModule('./src/meta');
const groups = loadModule('./src/groups');

// ---------- 值消毒（所有配置值出引擎前必须过这一层，杜绝 CSS/HTML 注入） ----------

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d\s,%.]+\s*\)|[a-zA-Z]{3,20}|transparent)$/;
const TOKEN_RE = /^[a-zA-Z0-9 _-]{0,120}$/; // CSS 类名 / FontAwesome 图标类名

function safeColor(v) {
	v = String(v == null ? '' : v).trim();
	return COLOR_RE.test(v) ? v : '';
}

function safeToken(v) {
	v = String(v == null ? '' : v).trim();
	return TOKEN_RE.test(v) ? v : '';
}

/** 渐变串 '135deg,#a,#b'：角度可省略（默认 135deg），至少 2 个合法颜色段 */
function safeGradient(v) {
	v = String(v == null ? '' : v).trim();
	if (!v) return '';
	const parts = v.split(',').map(s => s.trim()).filter(Boolean);
	if (parts.length < 2) return '';
	let angle = '135deg';
	if (/^\d{1,3}deg$/.test(parts[0])) angle = parts.shift();
	const colors = parts.map(safeColor);
	if (colors.length < 2 || colors.some(c => !c)) return '';
	return [angle].concat(colors).join(',');
}

function safeGlow(v) {
	const n = Math.round(Number(v) || 0);
	return Math.max(0, Math.min(10, n));
}

function safeInt(v, min, max, dft) {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return dft;
	return Math.max(min, Math.min(max, n));
}

function safeText(v, max) {
	return String(v == null ? '' : v).trim().slice(0, max);
}

function safeBoolOn(v) {
	return v === true || v === '1' || v === 'on' || v === 'true';
}

/** custom 出口：最多 10 个 string→string 键值（键白名单，值截断） */
function sanitizeCustom(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!TOKEN_RE.test(k)) continue;
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
			out[k] = safeText(v, 200);
		}
		if (Object.keys(out).length >= 10) break;
	}
	return out;
}

/** 规则清洗：宽容输入（ACP 表单字符串）、严格输出（类型确定、长度有界） */
function sanitizeRule(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const groupName = safeText(raw.groupName, 100);
	if (!groupName) return null;
	const badge = (raw.badge && typeof raw.badge === 'object') ? raw.badge : {};
	const name = (raw.name && typeof raw.name === 'object') ? raw.name : {};
	return {
		groupName,
		enabled: raw.enabled !== false && raw.enabled !== '0',
		priority: safeInt(raw.priority, -1000, 1000, 0),
		badge: {
			enabled: badge.enabled !== false && badge.enabled !== '0', // 徽章默认开（规则存在即想展示）
			label: safeText(badge.label, 40),
			icon: safeToken(badge.icon),
			color: safeColor(badge.color),
			textColor: safeColor(badge.textColor),
			gradient: safeGradient(badge.gradient),
			glow: safeGlow(badge.glow),
			className: safeToken(badge.className),
		},
		name: {
			enabled: safeBoolOn(name.enabled), // 用户名特效默认关（视觉侵入性强）
			gradient: safeGradient(name.gradient),
			color: safeColor(name.color),
			glow: safeGlow(name.glow),
			bold: safeBoolOn(name.bold),
			className: safeToken(name.className),
		},
		custom: sanitizeCustom(raw.custom),
	};
}

// ---------- 颜色工具（glow 光色 / 渐变底对比文字色，服务端一次算好，前端零成本） ----------

function hexToRgb(hex) {
	let h = String(hex || '').replace('#', '');
	if (h.length === 3) h = h.split('').map(c => c + c).join('');
	if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** 从渐变串/单色中提取首个 hex 色（rgba()/色名不解析，返回 null 走降级） */
function firstColor(gradient, color) {
	if (gradient) {
		for (const part of gradient.split(',')) {
			const m = part.trim().match(/^#[0-9a-fA-F]{3,8}$/);
			if (m) return hexToRgb(m[0]);
		}
		return null;
	}
	if (color && color.startsWith('#')) return hexToRgb(color);
	return null;
}

function glowCss(rgb, alpha) {
	if (!rgb) return 'rgba(255,255,255,.4)';
	return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** 相对亮度 → 自动黑白前景（管理员只配背景色也有可读对比度） */
function contrastText(rgb) {
	if (!rgb) return '#ffffff';
	const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
	return lum > 0.55 ? '#1f2328' : '#ffffff';
}

// ---------- 配置缓存 ----------

let cache = null; // { at, enabled, rules }，rules 已并入组元数据快照、按 priority 降序

/** 组元数据快照：只取 badge 渲染所需的最小字段集 */
function toGroupMeta(g) {
	if (!g) return null;
	return {
		name: g.name,
		slug: g.slug,
		userTitle: g.userTitle || g.name,
		icon: (g.icon && g.icon !== 'fa-nbb-none') ? g.icon : '',
		labelColor: g.labelColor || '',
		textColor: g.textColor || '',
	};
}

async function getConfig() {
	if (cache && (Date.now() - cache.at) < CACHE_TTL_MS) return cache;

	let settings = {};
	try {
		settings = (meta && (await meta.settings.get(SETTINGS_KEY))) || {};
	} catch (e) {
		console.error('[odysseia-decor] 配置读取失败', e.message);
	}

	let rawRules = [];
	try {
		rawRules = JSON.parse(settings.rules || '[]');
	} catch (e) {
		rawRules = []; // 脏配置 → 空规则，装饰静默关闭
	}
	if (!Array.isArray(rawRules)) rawRules = [];

	const rules = rawRules
		.map(sanitizeRule)
		.filter(r => r && r.enabled)
		.sort((a, b) => b.priority - a.priority);

	// 组元数据快照（slug/userTitle/icon/默认色）——组不存在时 group=null，badge 降级为纯文字
	if (groups && rules.length) {
		try {
			const names = [...new Set(rules.map(r => r.groupName))];
			const groupsData = await groups.getGroupsData(names);
			const byName = {};
			groupsData.forEach(g => {
				if (g) byName[g.name] = g;
			});
			rules.forEach(r => {
				r.group = toGroupMeta(byName[r.groupName]);
			});
		} catch (e) {
			console.error('[odysseia-decor] 组元数据快照失败', e.message);
			rules.forEach(r => {
				r.group = r.group || null;
			});
		}
	}

	cache = {
		at: Date.now(),
		// 默认启用（无规则时本就零开销）。'off' = ACP 表单未勾选 checkbox 的序列化值，
		// '0' = 手写配置兼容；两者都视为关闭（Settings API serializeForm 契约）
		enabled: settings.enabled !== '0' && settings.enabled !== 'off' && settings.enabled !== false,
		rules,
	};
	return cache;
}

/** 缓存失效（settings.set / group.update / group.rename 时由 library.js 转发调用） */
function invalidate() {
	cache = null;
}

// ---------- 装饰解析 ----------

/**
 * 命中规则（已按 priority 降序）→ 精简装饰数据。
 * 字段为空即省略，保持楼层 API payload 增量最小。
 */
function resolveDecor(hitRules) {
	const badges = [];
	for (const r of hitRules) {
		if (!r.badge.enabled) continue;
		const g = r.group;
		const rgb = firstColor(r.badge.gradient, r.badge.color)
			|| hexToRgb(g && g.labelColor);
		const badge = {
			slug: (g && g.slug) || '',
			label: r.badge.label || (g && g.userTitle) || r.groupName,
			icon: r.badge.icon || (g && g.icon) || '',
			grad: r.badge.gradient,
			bg: r.badge.gradient ? '' : (r.badge.color || (g && g.labelColor) || '#adb5bd'),
			fg: r.badge.textColor || (g && g.textColor) || contrastText(rgb),
		};
		if (r.badge.glow) {
			badge.glow = r.badge.glow;
			badge.glowColor = glowCss(rgb, 0.5);
		}
		if (r.badge.className) badge.className = r.badge.className;
		if (Object.keys(r.custom).length) badge.custom = r.custom;
		badges.push(badge);
	}

	let name = null;
	const nameRule = hitRules.find(r => r.name.enabled);
	if (nameRule) {
		const n = nameRule.name;
		const rgb = firstColor(n.gradient, n.color);
		const nd = {};
		if (n.gradient) nd.grad = n.gradient;
		else if (n.color) nd.color = n.color;
		if (n.bold) nd.bold = 1;
		if (n.glow) {
			nd.glow = n.glow;
			nd.glowColor = glowCss(rgb, 0.55);
		}
		if (n.className) nd.className = n.className;
		if (Object.keys(nd).length) name = nd;
	}

	if (!badges.length && !name) return null;
	return { badges, name };
}

/**
 * 批量解析用户装饰。
 * @param {Array<number|string>} uids
 * @returns {Promise<Object>} { [uid]: { badges, name } }（无装饰的用户不占键）
 */
async function decorateUsers(uids) {
	if (!groups || !Array.isArray(uids) || !uids.length) return {};
	const cfg = await getConfig();
	if (!cfg.enabled) return {};
	const activeRules = cfg.rules.filter(r => r.badge.enabled || r.name.enabled);
	if (!activeRules.length) return {};

	const unique = [...new Set(uids.map(u => Number(u)).filter(u => u > 0))];
	if (!unique.length) return {};

	// 成员判定：每规则一次批量查询（Groups.isMembers(uids, name)），次数=规则数、与楼层人数无关
	let memberships;
	try {
		memberships = await Promise.all(activeRules.map(r => groups.isMembers(unique, r.groupName)));
	} catch (e) {
		console.error('[odysseia-decor] 组成员批量查询失败', e.message);
		return {};
	}

	const out = {};
	unique.forEach((uid, i) => {
		const hit = activeRules.filter((r, ri) => memberships[ri] && memberships[ri][i]);
		const decor = resolveDecor(hit);
		if (decor) out[uid] = decor;
	});
	return out;
}

/** 单用户便捷入口（onPostSave 等低频路径用） */
async function decorateOne(uid) {
	const map = await decorateUsers([uid]);
	return map[Number(uid)] || null;
}

module.exports = {
	getConfig,
	decorateUsers,
	decorateOne,
	invalidate,
};
