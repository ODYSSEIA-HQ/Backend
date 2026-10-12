<!-- ΟΔΥΣΣΕΙΑ 身分组装饰 · ACP 配置面 -->
<!-- hash = odysseia-decor（与服务端 lib/decor.js SETTINGS_KEY、library.js onSettingsSet 三方一致） -->
<!-- 契约：卡片内动态字段一律不带 name 属性（serializeForm 只收集 named 控件， -->
<!-- settings hash 因此只存 enabled / rules 两个键）；rules 为 JSON 字符串，由卡片 UI 手动序列化 -->
<div class="row">
	<div class="col-12 col-xl-9">
		<form id="odysseia-decor-form" autocomplete="off">
			<div class="card mb-3">
				<div class="card-header">全局开关</div>
				<div class="card-body">
					<div class="form-check form-switch">
						<input class="form-check-input" type="checkbox" role="switch" id="ody-enabled" name="enabled">
						<label class="form-check-label" for="ody-enabled">启用身分组装饰（总闸；关闭后全站隐藏，规则保留）</label>
					</div>
					<input type="hidden" name="rules" id="rules-json" value="">
				</div>
			</div>

			<div class="card mb-3">
				<div class="card-header d-flex align-items-center justify-content-between">
					<span>装饰规则 <small class="text-body-secondary">（按优先级降序生效；同一用户命中多条时 pill 全部展示，用户名特效取最高优先级）</small></span>
					<button type="button" class="btn btn-sm btn-primary" id="add-rule"><i class="fa fa-plus"></i> 添加规则</button>
				</div>
				<div class="card-body">
					<div id="rules-list"></div>
					<div id="rules-empty-hint" class="text-body-secondary small py-4 text-center border rounded d-none">
						尚无装饰规则。点击右上「添加规则」，绑定一个 NodeBB 用户组开始定制。
					</div>
				</div>
			</div>

			<button type="button" class="btn btn-primary" id="save"><i class="fa fa-save"></i> 保存</button>
		</form>
	</div>

	<div class="col-12 col-xl-3">
		<div class="card">
			<div class="card-header">说明</div>
			<div class="card-body small">
				<ul class="mb-0 ps-3">
					<li>生效范围：原生楼层、用户 profile、站内聊天室三端同款。</li>
					<li>组名填 NodeBB <b>组系统名</b>（管理 → 用户与组 → 组）；组名不存在时规则自然不命中。</li>
					<li>标签 / 图标 / 底色留空 → 自动取组设置（头衔 / 图标 / 徽章色），文字色自动计算对比度。</li>
					<li>渐变格式 <code>135deg,#ff5500,#7c3aed</code>（角度可省略，至少两段颜色）；与单色底色二选一，渐变优先。</li>
					<li>图标填 FontAwesome 类名（如 <code>fa-crown</code>）。</li>
					<li>辉光 0–10；用户名渐变与辉光互斥（裁剪文字吃不掉阴影），渐变命中时辉光自动降级。</li>
					<li>custom 出口：每行 <code>key=value</code>，渲染为 <code>data-ody-key</code> 属性，供自定义 CSS/JS 取用（值服务端消毒）。</li>
					<li>性能护栏：零动画零过渡，纯静态绘制；成员判定按规则数批量查询，与页面人数无关。</li>
					<li>保存后即时生效（服务端缓存自动失效；多进程部署最长 5 分钟 TTL 兜底）。</li>
				</ul>
			</div>
		</div>
	</div>
</div>

<style>
/* 预览样式：与前端 static/lib/decor.css 骨架一致（ACP 内联自包含，不依赖前台 css 注入） */
#rules-list .rule-preview {
	display: flex;
	align-items: center;
	gap: .75rem;
	flex-wrap: wrap;
	padding: .45rem .75rem;
	background: var(--bs-tertiary-bg, #f8f9fa);
	border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}
#rules-list .ody-pill {
	display: inline-flex;
	align-items: center;
	gap: .25em;
	padding: .1em .55em;
	border-radius: 999px;
	line-height: 1.6;
	font-size: .82rem;
	font-weight: 600;
	letter-spacing: .02em;
	max-width: 220px;
	white-space: nowrap;
	vertical-align: middle;
}
#rules-list .ody-pill > i.fa {
	font-size: .9em;
	line-height: 1;
	flex: none;
}
#rules-list .ody-pill-text {
	overflow: hidden;
	text-overflow: ellipsis;
}
#rules-list .ody-name-grad {
	-webkit-background-clip: text;
	background-clip: text;
	-webkit-text-fill-color: transparent;
	color: transparent;
}
#rules-list .ody-name-sample {
	font-size: .95rem;
	font-weight: 500;
}
#rules-list .form-label {
	margin-bottom: .15rem;
}
</style>

<script>
require(['settings', 'alerts'], function (Settings, alerts) {
	var HASH = 'odysseia-decor';
	var form = $('#odysseia-decor-form');
	var list = $('#rules-list');
	var hint = $('#rules-empty-hint');

	// ---------- 工具 ----------

	function esc(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	/** custom 对象 ↔ textarea 文本（每行 key=value） */
	function customToText(obj) {
		return Object.keys(obj || { }).map(function (k) { return k + '=' + obj[k]; }).join('\n');
	}

	function textToCustom(text) {
		var out = { };
		String(text || '').split('\n').forEach(function (line) {
			var i = line.indexOf('=');
			if (i <= 0) return;
			var k = line.slice(0, i).trim();
			var v = line.slice(i + 1).trim();
			if (k) out[k] = v;
		});
		return out;
	}

	// ---------- 规则卡片 ----------

	function ruleCardHtml(rule) {
		rule = rule || { };
		var b = rule.badge || { };
		var n = rule.name || { };
		var rOn = rule.enabled !== false && rule.enabled !== '0';
		var bOn = b.enabled !== false && b.enabled !== '0';
		var nOn = n.enabled === true || n.enabled === 'on' || n.enabled === '1' || n.enabled === 'true';
		var priority = Number(rule.priority) || 0;

		return '' +
			'<div class="card mb-3 rule-card">' +
				'<div class="card-header d-flex flex-wrap align-items-center gap-2">' +
					'<div class="form-check form-switch mb-0" title="规则启用/停用">' +
						'<input class="form-check-input f-enabled" type="checkbox" role="switch"' + (rOn ? ' checked' : '') + '>' +
					'</div>' +
					'<input type="text" class="form-control form-control-sm f-groupname" maxlength="100" style="max-width:260px" placeholder="组系统名（必填）" value="' + esc(rule.groupName) + '">' +
					'<span class="badge rule-state text-bg-secondary">停用</span>' +
					'<div class="ms-auto d-flex align-items-center gap-2">' +
						'<input type="number" class="form-control form-control-sm f-priority" min="-1000" max="1000" step="1" style="width:86px" value="' + esc(priority) + '" title="优先级（大者靠前，-1000~1000）">' +
						'<button type="button" class="btn btn-sm btn-outline-secondary rule-toggle">收起</button>' +
						'<button type="button" class="btn btn-sm btn-outline-danger rule-delete" title="删除此规则"><i class="fa fa-trash" aria-hidden="true"></i></button>' +
					'</div>' +
				'</div>' +
				'<div class="rule-preview"></div>' +
				'<div class="card-body rule-body">' +

					'<label class="form-check form-switch mb-2">' +
						'<input class="form-check-input f-badge-enabled" type="checkbox" role="switch"' + (bOn ? ' checked' : '') + '>' +
						'<span class="form-check-label fw-semibold">徽章 pill <span class="text-body-secondary fw-normal small">（颜色留空自动取组设置）</span></span>' +
					'</label>' +
					'<div class="row g-2 mb-3">' +
						'<div class="col-12 col-md-4">' +
							'<div class="form-label small text-body-secondary">标签（≤40 字，留空取组头衔）</div>' +
							'<input type="text" class="form-control form-control-sm f-badge-label" maxlength="40" value="' + esc(b.label) + '">' +
						'</div>' +
						'<div class="col-6 col-md-4">' +
							'<div class="form-label small text-body-secondary">图标（FontAwesome 类名）</div>' +
							'<input type="text" class="form-control form-control-sm f-badge-icon" maxlength="120" placeholder="fa-crown" value="' + esc(b.icon) + '">' +
						'</div>' +
						'<div class="col-6 col-md-4">' +
							'<div class="form-label small text-body-secondary">自定义类名</div>' +
							'<input type="text" class="form-control form-control-sm f-badge-class" maxlength="120" placeholder="my-badge" value="' + esc(b.className) + '">' +
						'</div>' +
						'<div class="col-6 col-md-3">' +
							'<div class="form-label small text-body-secondary">底色</div>' +
							'<input type="text" class="form-control form-control-sm f-badge-color" maxlength="40" placeholder="#ff5500 / rgba(...) / darkred" value="' + esc(b.color) + '">' +
						'</div>' +
						'<div class="col-6 col-md-3">' +
							'<div class="form-label small text-body-secondary">文字色</div>' +
							'<input type="text" class="form-control form-control-sm f-badge-textcolor" maxlength="40" placeholder="留空自动对比度" value="' + esc(b.textColor) + '">' +
						'</div>' +
						'<div class="col-12 col-md-6">' +
							'<div class="form-label small text-body-secondary">渐变底（与底色二选一，渐变优先）</div>' +
							'<input type="text" class="form-control form-control-sm f-badge-gradient" maxlength="120" placeholder="135deg,#ff5500,#7c3aed" value="' + esc(b.gradient) + '">' +
						'</div>' +
						'<div class="col-6 col-md-3">' +
							'<div class="form-label small text-body-secondary">辉光（0–10）</div>' +
							'<input type="number" class="form-control form-control-sm f-badge-glow" min="0" max="10" step="1" value="' + (Number(b.glow) || 0) + '">' +
						'</div>' +
					'</div>' +

					'<div class="d-flex flex-wrap align-items-center gap-3 mb-2">' +
						'<label class="form-check form-switch mb-0">' +
							'<input class="form-check-input f-name-enabled" type="checkbox" role="switch"' + (nOn ? ' checked' : '') + '>' +
							'<span class="form-check-label fw-semibold">用户名特效 <span class="text-body-secondary fw-normal small">（视觉侵入性强，默认关）</span></span>' +
						'</label>' +
						'<label class="form-check mb-0 small">' +
							'<input class="form-check-input f-name-bold" type="checkbox"' + (n.bold ? ' checked' : '') + '> 加粗' +
						'</label>' +
					'</div>' +
					'<div class="row g-2 mb-3">' +
						'<div class="col-12 col-md-6">' +
							'<div class="form-label small text-body-secondary">渐变文字（与文字色二选一，渐变优先）</div>' +
							'<input type="text" class="form-control form-control-sm f-name-gradient" maxlength="120" placeholder="135deg,#7c3aed,#22d3ee" value="' + esc(n.gradient) + '">' +
						'</div>' +
						'<div class="col-6 col-md-3">' +
							'<div class="form-label small text-body-secondary">文字色</div>' +
							'<input type="text" class="form-control form-control-sm f-name-color" maxlength="40" placeholder="#7c3aed" value="' + esc(n.color) + '">' +
						'</div>' +
						'<div class="col-6 col-md-3">' +
							'<div class="form-label small text-body-secondary">辉光（0–10）</div>' +
							'<input type="number" class="form-control form-control-sm f-name-glow" min="0" max="10" step="1" value="' + (Number(n.glow) || 0) + '">' +
						'</div>' +
						'<div class="col-12 col-md-6">' +
							'<div class="form-label small text-body-secondary">自定义类名</div>' +
							'<input type="text" class="form-control form-control-sm f-name-class" maxlength="120" placeholder="my-name-fx" value="' + esc(n.className) + '">' +
						'</div>' +
					'</div>' +

					'<div class="form-label small text-body-secondary">自定义出口（每行 key=value，最多 10 条；渲染为 data-ody-key 属性，供自定义 CSS/JS 取用）</div>' +
					'<textarea class="form-control form-control-sm f-custom" rows="2" placeholder="tier=gold&#10;season=2026">' + esc(customToText(rule.custom)) + '</textarea>' +

				'</div>' +
			'</div>';
	}

	function defaultRule() {
		return {
			groupName: '',
			enabled: true,
			priority: 0,
			badge: { enabled: true, label: '', icon: '', color: '', textColor: '', gradient: '', glow: 0, className: '' },
			name: { enabled: false, gradient: '', color: '', glow: 0, bold: false, className: '' },
			custom: { },
		};
	}

	function addCard(rule) {
		var $card = $(ruleCardHtml(rule));
		list.append($card);
		updatePreview($card);
	}

	function renderRules(rules) {
		list.empty();
		if (!rules.length) {
			hint.removeClass('d-none');
			return;
		}
		hint.addClass('d-none');
		rules.forEach(addCard);
	}

	// ---------- 实时预览（对齐前端 renderPill / applyNameFx 与服务端兜底逻辑） ----------

	function updatePreview($card) {
		if (!$card || !$card.length) return;
		var on = $card.find('.f-enabled').is(':checked');

		$card.find('.rule-state')
			.toggleClass('text-bg-success', on)
			.toggleClass('text-bg-secondary', !on)
			.text(on ? '启用' : '停用');

		var $preview = $card.find('.rule-preview').empty();
		if (!on) {
			$('<span class="text-body-secondary small"></span>').text('（规则已停用）').appendTo($preview);
			return;
		}

		var groupName = String($card.find('.f-groupname').val() || '').trim();
		var nameSample = groupName ? (groupName + '成员') : '示例用户名';

		// 用户名特效
		var $name = $('<span class="ody-name-sample"></span>').text(nameSample);
		if ($card.find('.f-name-enabled').is(':checked')) {
			var nGrad = String($card.find('.f-name-gradient').val() || '').trim();
			var nColor = String($card.find('.f-name-color').val() || '').trim();
			var nGlow = Number($card.find('.f-name-glow').val()) || 0;
			if (nGrad) {
				$name.css('background-image', 'linear-gradient(' + nGrad + ')').addClass('ody-name-grad');
			} else if (nColor) {
				$name.css('color', nColor);
			}
			if ($card.find('.f-name-bold').is(':checked')) {
				$name.css('font-weight', '700');
			}
			if (nGlow && !nGrad) {
				var gc = 'rgba(255,255,255,.55)';
				$name.css('text-shadow', '0 0 ' + Math.max(2, Math.round(nGlow / 2)) + 'px ' + gc + ', 0 0 ' + nGlow + 'px ' + gc);
			}
		}
		$preview.append($name);

		// badge pill（label / 颜色留空时模拟服务端组元数据兜底）
		if ($card.find('.f-badge-enabled').is(':checked')) {
			var label = String($card.find('.f-badge-label').val() || '').trim() || (groupName || '徽章');
			var grad = String($card.find('.f-badge-gradient').val() || '').trim();
			var bg = String($card.find('.f-badge-color').val() || '').trim() || '#adb5bd';
			var fg = String($card.find('.f-badge-textcolor').val() || '').trim() || '#ffffff';
			var icon = String($card.find('.f-badge-icon').val() || '').trim();
			var glow = Number($card.find('.f-badge-glow').val()) || 0;

			var $pill = $('<span class="ody-pill"></span>');
			if (grad) {
				$pill.css('background-image', 'linear-gradient(' + grad + ')');
			} else {
				$pill.css('background-color', bg);
			}
			$pill.css('color', fg);
			if (glow) {
				$pill.css('box-shadow', '0 0 ' + glow + 'px rgba(255,255,255,.4)');
			}
			if (icon) {
				var iEl = document.createElement('i');
				iEl.className = 'fa ' + icon;
				iEl.setAttribute('aria-hidden', 'true');
				$pill.append(iEl);
			}
			$('<span class="ody-pill-text"></span>').text(label).appendTo($pill);
			$preview.append($pill);
		}
	}

	// ---------- 收集（卡片 → rules 数组，boolean 形态对齐服务端 sanitizeRule） ----------

	function collectRules() {
		var rules = [];
		list.find('.rule-card').each(function () {
			var $c = $(this);
			var groupName = String($c.find('.f-groupname').val() || '').trim();
			if (!groupName) return; // 未填组名的卡片保存时忽略（服务端 sanitizeRule 同样丢弃）
			rules.push({
				groupName: groupName,
				enabled: $c.find('.f-enabled').is(':checked'),
				priority: Number($c.find('.f-priority').val()) || 0,
				badge: {
					enabled: $c.find('.f-badge-enabled').is(':checked'),
					label: $c.find('.f-badge-label').val(),
					icon: $c.find('.f-badge-icon').val(),
					color: $c.find('.f-badge-color').val(),
					textColor: $c.find('.f-badge-textcolor').val(),
					gradient: $c.find('.f-badge-gradient').val(),
					glow: Number($c.find('.f-badge-glow').val()) || 0,
					className: $c.find('.f-badge-class').val(),
				},
				name: {
					enabled: $c.find('.f-name-enabled').is(':checked'),
					gradient: $c.find('.f-name-gradient').val(),
					color: $c.find('.f-name-color').val(),
					glow: Number($c.find('.f-name-glow').val()) || 0,
					bold: $c.find('.f-name-bold').is(':checked'),
					className: $c.find('.f-name-class').val(),
				},
				custom: textToCustom($c.find('.f-custom').val()),
			});
		});
		return rules;
	}

	// ---------- 事件 ----------

	/** 增删规则不走 input/change，手动触发 hidden rules 的 change 让 Settings 标记 _unsaved */
	function markDirty() {
		form.find('[name="rules"]').trigger('change');
	}

	form.on('input', '.rule-card input, .rule-card textarea', function () {
		updatePreview($(this).closest('.rule-card'));
	});

	$('#add-rule').on('click', function () {
		addCard(defaultRule());
		hint.addClass('d-none');
		list.find('.rule-card').last().find('.f-groupname').trigger('focus');
		markDirty();
	});

	form.on('click', '.rule-delete', function () {
		$(this).closest('.rule-card').remove();
		if (!list.find('.rule-card').length) {
			hint.removeClass('d-none');
		}
		markDirty();
	});

	form.on('click', '.rule-toggle', function () {
		var $btn = $(this);
		var $body = $btn.closest('.rule-card').find('.rule-body');
		$body.slideToggle(150);
		$btn.text($body.is(':visible') ? '收起' : '展开');
	});

	// ---------- 加载 / 保存 ----------

	$('#save').on('click', function (ev) {
		ev.preventDefault();
		var rules = collectRules();
		var dropped = list.find('.rule-card').length - rules.length;
		form.find('[name="rules"]').val(JSON.stringify(rules));
		Settings.save(HASH, form, function (err) {
			if (err) {
				alerts.alert({ title: '保存失败', message: err.message, type: 'danger', timeout: 5000 });
				return;
			}
			// 复刻 Settings.save 无 callback 分支的按钮反馈
			var btn = document.getElementById('save');
			btn.classList.add('saved');
			setTimeout(function () { btn.classList.remove('saved'); }, 1500);
			alerts.alert({
				title: '配置已保存',
				type: 'success',
				alert_id: 'ody-decor-saved',
				message: dropped > 0
					? '已忽略 ' + dropped + ' 条未填组名的规则，其余规则即时生效'
					: '装饰规则已保存，全站即时生效',
				timeout: 3500,
			});
		});
	});

	Settings.load(HASH, form, function (err, values) {
		if (err) {
			alerts.alert({ title: '配置读取失败', message: err.message, type: 'danger', timeout: 5000 });
			return;
		}
		values = values || { };
		// 首次使用（从未保存过）：服务端默认启用（见 lib/decor.js），UI 对齐避免「显示关闭、实际生效」错位
		if (values.enabled === undefined) {
			form.find('[name="enabled"]').prop('checked', true);
		}
		var rules = [];
		try {
			rules = JSON.parse(form.find('[name="rules"]').val() || '[]');
		} catch (e) {
			rules = []; // 脏 JSON → 空规则（服务端 getConfig 同样静默降级）
		}
		renderRules(Array.isArray(rules) ? rules : []);
	});
});
</script>
