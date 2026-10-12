'use strict';

/**
 * ΟΔΥΣΣΕΙΑ 身分组装饰 · 前端渲染器 + 原生页面注入器
 *
 * 职责（三端同源，保证「同一用户处处同款」）：
 *   1. 统一渲染原语：badge pill / 用户名特效（楼层、profile、聊天室共用）
 *   2. 原生 NodeBB 页面注入：
 *      - 楼层首屏（冷加载 SSR / ajaxify 导航）：action:ajaxify.contentLoaded
 *        先从 ajaxify.data.posts 收割 odyDecor 入缓存，再 DOM 扫描注入。
 *        冷加载不走 action:posts.loaded（该事件仅新回复/无限滚动 fire，
 *        public/src/client/topic/posts.js 实证），故首屏必须依赖 ajaxify.data
 *      - 楼层增量（新回复/无限滚动）：action:posts.loaded 批量注入
 *      - profile：action:ajaxify.contentLoaded + ajaxify.data.odyDecor
 *      - 幂等：decoratePost / decorateProfile 均有元素级标记（contentLoaded
 *        与 document.ready 双触发不重复注入）
 *   3. uid→decor 前端缓存：聊天室实时消息复用（onPostSave 广播附带 decor）
 *
 * 数据契约（服务端 lib/decor.js resolveDecor 输出，字段空即省略）：
 *   odyDecor = { badges: [{ slug, label, icon, grad, bg, fg, glow?, glowColor?, className?, custom? }],
 *                name:    { grad?, color?, bold?, glow?, glowColor?, className? } } | null
 *
 * 与原生 badge 的关系（去重策略）：
 *   ody pill 展示的组 → 同 slug 原生 badge 加 .ody-native-hidden 隐藏；
 *   无规则命中的组 → 原生 badge 照常显示。不重复、不丢失。
 *
 * 性能护栏：
 *   - 渲染纯静态 DOM + inline style，零动画零 transition（管理员可经 custom/className 自行叠加）
 *   - 渐变文字用 background-clip:text（GPU 合成友好；注意其与 text-shadow 互斥，glow 自动降级）
 *   - 全部注入幂等（.ody-pills 容器 / data-ody-fx 标记防重复）
 */

(function () {
	var relativePath = (typeof config !== 'undefined' && config && config.relative_path) || '';

	// ---------- uid → decor 前端缓存（楼层注入与聊天室共享；值为 null 表示「确认无装饰」） ----------

	var decorCache = {};

	function cacheDecor(uid, decor) {
		uid = Number(uid);
		if (uid > 0) decorCache[uid] = decor || null;
	}

	function getDecor(uid) {
		uid = Number(uid);
		return Object.prototype.hasOwnProperty.call(decorCache, uid) ? decorCache[uid] : undefined;
	}

	// ---------- 渲染原语 ----------

	/** badge → pill DOM。slug 存在时为组链接（对齐原生 badge 交互），否则为纯展示 span */
	function renderPill(badge) {
		if (!badge) return null;
		var el = badge.slug ? document.createElement('a') : document.createElement('span');
		if (badge.slug) el.href = relativePath + '/groups/' + badge.slug;
		el.className = 'ody-pill' + (badge.className ? ' ' + badge.className : '');
		if (badge.label) {
			el.title = badge.label;
			el.setAttribute('aria-label', badge.label);
		}

		/* 底色：渐变优先（grad 有值时 bg 为空串），其次单色；前景色服务端已算好自动对比度 */
		if (badge.grad) {
			el.style.backgroundImage = 'linear-gradient(' + badge.grad + ')';
		} else if (badge.bg) {
			el.style.backgroundColor = badge.bg;
		}
		if (badge.fg) el.style.color = badge.fg;
		if (badge.glow) {
			el.style.boxShadow = '0 0 ' + badge.glow + 'px ' + (badge.glowColor || 'rgba(255,255,255,.4)');
		}

		if (badge.icon) {
			var icon = document.createElement('i');
			icon.className = 'fa ' + badge.icon;
			icon.setAttribute('aria-hidden', 'true');
			el.appendChild(icon);
		}
		if (badge.label) {
			var text = document.createElement('span');
			text.className = 'ody-pill-text';
			text.textContent = badge.label;
			el.appendChild(text);
		}

		/* custom 出口：全部挂 data-ody-*，管理员 CSS/JS 自由取用（值服务端已消毒） */
		if (badge.custom) {
			Object.keys(badge.custom).forEach(function (k) {
				el.setAttribute('data-ody-' + k, badge.custom[k]);
			});
		}
		return el;
	}

	/**
	 * 用户名特效。对楼层 a[data-uid]、profile h2.username、聊天室 .ody-user 通用。
	 * 幂等：data-ody-fx 标记。
	 * 注：渐变文字（clip:text）与 text-shadow 互斥（shadow 会被裁剪），grad 命中时 glow 自动降级。
	 */
	function applyNameFx(el, name) {
		if (!el || !name) return;
		if (el.getAttribute('data-ody-fx')) return;
		el.setAttribute('data-ody-fx', '1');

		if (name.grad) {
			el.style.backgroundImage = 'linear-gradient(' + name.grad + ')';
			el.classList.add('ody-name-grad');
		} else if (name.color) {
			el.style.color = name.color;
		}
		if (name.bold) el.style.fontWeight = '700';
		if (name.glow && !name.grad) {
			var d = Number(name.glow) || 3;
			var gc = name.glowColor || 'rgba(255,255,255,.55)';
			el.style.textShadow = '0 0 ' + Math.max(2, Math.round(d / 2)) + 'px ' + gc + ',0 0 ' + d + 'px ' + gc;
		}
		if (name.className) {
			name.className.split(/\s+/).filter(Boolean).forEach(function (c) {
				el.classList.add(c);
			});
		}
	}

	/** 原生 badge 去重：scope 内 href 指向同 slug 组的原生 badge 隐藏（可逆 class，非移除） */
	function hideNativeBadges(scope, badges) {
		if (!scope || !badges || !badges.length) return;
		var slugs = {};
		badges.forEach(function (b) {
			if (b && b.slug) slugs[b.slug] = true;
		});
		if (!Object.keys(slugs).length) return;
		scope.querySelectorAll('a.badge[href*="/groups/"]').forEach(function (a) {
			var m = (a.getAttribute('href') || '').match(/\/groups\/([^/?#]+)/);
			if (m && slugs[m[1]]) a.classList.add('ody-native-hidden');
		});
	}

	/** pill 组容器（一次创建、内部追加；幂等：容器存在即复用） */
	function ensurePillContainer(parent, anchorEl) {
		if (!parent) return null;
		var existing = parent.querySelector(':scope > .ody-pills');
		if (existing) return existing;
		var wrap = document.createElement('span');
		wrap.className = 'ody-pills';
		if (anchorEl && anchorEl.parentNode === parent) {
			parent.insertBefore(wrap, anchorEl);
		} else {
			parent.appendChild(wrap);
		}
		return wrap;
	}

	// ---------- 原生页面注入：楼层 ----------

	/**
	 * 单楼层注入。
	 * postEl = [component="post"] 元素；锚点 DOM 均为 NodeBB 跨主题稳定结构：
	 *   用户名  a[data-username][data-uid]（Persona post.tpl 实证）
	 *   原生 badge  a.badge[href*="/groups/"]（核心 partials/groups/badge.tpl 实证）
	 */
	function decoratePost(postEl, decor) {
		if (!postEl || !decor) return;
		/* 幂等：contentLoaded 与 document.ready 双触发、与 posts.loaded 补注入共用此入口，
		   标记防 pill 翻倍；标记在注入成功后设置，中途异常下次仍可重试 */
		if (postEl.getAttribute('data-ody-decorated')) return;
		try {
			var nameEl = postEl.querySelector('a[data-username][data-uid]');
			if (nameEl && decor.name) applyNameFx(nameEl, decor.name);

			if (decor.badges && decor.badges.length) {
				/* 插入位：用户名所在 flex 容器；锚 = 首个原生组 badge（排在原生 badge 旁，视觉连贯） */
				var flexParent = nameEl ? nameEl.closest('.d-flex') : null;
				var anchor = postEl.querySelector('a.badge[href*="/groups/"]');
				var container = ensurePillContainer(flexParent || postEl.querySelector('.post-header'), anchor);
				if (container) {
					decor.badges.forEach(function (b) {
						var pill = renderPill(b);
						if (pill) container.appendChild(pill); // null 过滤：脏数据不中断整楼注入
					});
					hideNativeBadges(postEl, decor.badges);
				}
			}
			postEl.setAttribute('data-ody-decorated', '1');
		} catch (e) {
			/* 单楼注入失败不影响其他楼层 */
		}
	}

	/** action:posts.loaded 批量入口。payload = { posts: [...] }（topic/replies/account-posts 三路统一） */
	function onPostsLoaded(data) {
		var posts = (data && data.posts) || [];
		posts.forEach(function (post) {
			var user = post && post.user;
			if (!user || !user.uid) return;
			/* payload 内带 odyDecor（服务端 filter:posts.getUserInfoForPosts 注入）则刷新缓存；
			   缺失时用缓存兜底（主题自定义加载路径） */
			var decor = user.odyDecor !== undefined ? user.odyDecor : getDecor(user.uid);
			cacheDecor(user.uid, decor);
			if (!decor) return;
			var el = post.pid ? document.querySelector('[component="post"][data-pid="' + post.pid + '"]') : null;
			if (el) decoratePost(el, decor);
		});
	}

	// ---------- 原生页面注入：profile ----------

	/**
	 * profile 页注入。数据源 = ajaxify.data.odyDecor（服务端 filter:helpers.getUserDataByUserSlug 注入）。
	 * DOM：h2.username + 其后原生 selectedGroup badge 区（Persona account/profile.tpl 实证）。
	 */
	function decorateProfile() {
		var h2 = document.querySelector('h2.username');
		if (!h2) return;
		if (h2.getAttribute('data-ody-decorated')) return; // 幂等：contentLoaded 与 document.ready 双触发
		var data = (typeof ajaxify !== 'undefined' && ajaxify.data) || {};
		var decor = data.odyDecor !== undefined ? data.odyDecor : getDecor(data.uid);
		if (!decor) return;
		cacheDecor(data.uid, decor);

		if (decor.name) applyNameFx(h2, decor.name);
		if (decor.badges && decor.badges.length) {
			var parent = h2.parentNode;
			if (!parent.querySelector(':scope > .ody-pills')) {
				var wrap = document.createElement('div');
				wrap.className = 'ody-pills ody-pills-profile';
				parent.insertBefore(wrap, h2.nextSibling);
			}
			var container = parent.querySelector(':scope > .ody-pills');
			decor.badges.forEach(function (b) {
				var pill = renderPill(b);
				if (pill) container.appendChild(pill); // null 过滤：脏数据不中断整组注入
			});
			/* 去重范围仅限 profile 头部区（h2 父级），不误伤页内帖子列表的楼层 badge */
			hideNativeBadges(parent, decor.badges);
		}
		h2.setAttribute('data-ody-decorated', '1');
	}

	/**
	 * 首屏收割：冷加载（SSR 直出）不走 action:posts.loaded（该事件仅新回复/无限滚动 fire，
	 * public/src/client/topic/posts.js createNewPosts 实证），故从 ajaxify.data.posts 补缓存。
	 * 两条路径数据同源（服务端 filter:posts.getUserInfoForPosts 已注入 user.odyDecor）：
	 *   - 冷加载：ajaxify.data = SSR 注入的 window._ajaxifyData（public/src/ajaxify.js 顶部实证）
	 *   - ajaxify 导航：ajaxify.data = /api 响应（loadData success 赋值，end 前必达）
	 * 字段缺失（无规则/未启用）则跳过，不污染缓存语义。
	 */
	function harvestAjaxifyPosts() {
		try {
			var d = (typeof ajaxify !== 'undefined' && ajaxify && ajaxify.data) || null;
			if (!d || !Array.isArray(d.posts)) return;
			d.posts.forEach(function (post) {
				var user = post && post.user;
				if (!user || !user.uid || user.odyDecor === undefined) return;
				cacheDecor(user.uid, user.odyDecor);
			});
		} catch (e) {
			/* 收割失败走 scanVisiblePosts 原有缓存兜底 */
		}
	}

	/** 首屏兜底扫描：action:posts.loaded 时序错过时按 DOM data-uid + 缓存补注入 */
	function scanVisiblePosts() {
		document.querySelectorAll('[component="post"]').forEach(function (el) {
			var a = el.querySelector('a[data-username][data-uid]');
			if (!a) return;
			var decor = getDecor(a.getAttribute('data-uid'));
			if (decor) decoratePost(el, decor);
		});
	}

	/** contentLoaded / document.ready 共用注入入口：先收割数据再扫 DOM */
	function decorateCurrentPage() {
		harvestAjaxifyPosts();
		decorateProfile();
		scanVisiblePosts();
	}

	// ---------- 事件接线 ----------

	if (typeof hooks !== 'undefined') {
		hooks.on('action:posts.loaded', onPostsLoaded);
		hooks.on('action:ajaxify.contentLoaded', decorateCurrentPage);
	}

	if (typeof $ !== 'undefined') {
		$(document).ready(decorateCurrentPage);
	}

	// ---------- 对外 API（聊天室 chat.js 消费；注入器内部同样适用） ----------

	window.odyDecor = {
		renderPill: renderPill,
		applyNameFx: applyNameFx,
		cacheDecor: cacheDecor,
		getDecor: getDecor,
	};
})();
