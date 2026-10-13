'use strict';

/**
 * ΟΔΥΣΣΕΙΑ 聊天室呈现层（bridge 插件前端）
 *
 * 职责：把 NodeBB topic 页变成"聊天室"（架构 D5 帖子=聊天室语义）——
 *   1. Centrifugo WS 实时流：message.new/edit/delete/... → DOM 同步
 *   2. typing 指示器 + 在线人数（presence 频道）
 *   3. 自动滚动 + 底部"新消息"提示（不打扰翻历史的人）
 *   4. 与 NodeBB 原生 Socket.IO 实时层双通道共存：按 pid 去重，互为 fallback
 *
 * 载入方式：plugin.json scripts 字段（NodeBB 每页注入）
 * SDK 来源：BFF 静态托管 /bff/vendor/centrifuge.js（本文件动态加载）
 *
 * 频道：
 *   topic:{tid}         消息流（服务端 bridge 插件广播）
 *   typing:topic:{tid}  正在输入（presence + 订阅者可 publish）
 *   user:{uid}          多端同步（chat.sent 等，演示层仅打日志）
 */

(function () {
	'use strict';

	if (typeof window === 'undefined') return;

	// ---------- 常量 ----------

	var SDK_URL = '/bff/vendor/centrifuge.js';
	var TOKEN_URL = '/bff/token';
	var TYPE_DEBOUNCE = 2000;  // typing 心跳最小间隔（ms）
	var TYPING_TTL = 5000;     // typing 指示消失时间（ms）
	var NEAR_BOTTOM = 300;     // 距底多少像素内算"贴底"（自动滚动生效）
	var UI_TICK = 500;         // UI 轮询间隔（typing 过期 / 未读按钮）

	// ---------- 状态 ----------

	var state = {
		centrifuge: null,      // Centrifuge 单例（跨页面复用，省握手）
		connecting: false,     // 防止并发连接
		uid: 0,                // 当前登录用户（游客=0，不连 WS）
		tid: 0,                // 当前聊天室 topic id
		topicSub: null,
		typingSub: null,
		userSub: null,
		users: {},             // uid → {username, picture} 身份缓存
		typers: {},            // uid → {username, expireAt}
		presence: {},          // client → {uid}
		lastTypingSent: 0,
		unread: 0,
		uiTimer: null,
		// 历史无限加载（向上滚动拉更早一页）
		topicSlug: '',        // 当前 topic slug（fetch /api/topic/{slug}?page=N 用）
		pageFloor: 0,         // 已渲染的最小页码，向上递减到 1 封顶
		historyLoading: false,
		noMoreHistory: false,
	};

	// ---------- 工具 ----------

	function log() {
		var args = Array.prototype.slice.call(arguments);
		args.unshift('[odysseia-chat]');
		if (window.console) console.log.apply(console, args);
	}

	/** HTML 转义：用于拼入 HTML 属性/内容（消息正文不走这里，走 .text()） */
	function esc(s) {
		s = String(s == null ? '' : s);
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	/** 动态加载 centrifuge SDK（BFF 静态托管，无 CDN 依赖）；errCb 必须调，否则 connecting 永真卡死 */
	function loadSDK(cb, errCb) {
		if (window.Centrifuge) return cb();
		var s = document.createElement('script');
		s.src = SDK_URL;
		s.onload = function () { cb(); };
		s.onerror = function () {
			log('SDK 加载失败（BFF 不可达？），实时层降级为 NodeBB 原生通道');
			if (errCb) errCb();
		};
		document.head.appendChild(s);
	}

	/** 取连接 token：SDK 首连与 token 临期时自动回调（BFF /token 按会话签发，2h TTL 自动续期） */
	function fetchToken() {
		return fetch(TOKEN_URL, { credentials: 'include' }).then(function (res) {
			if (!res.ok) throw new Error('token ' + res.status);
			return res.json();
		}).then(function (data) {
			return data.token;
		});
	}

	/** 游客不连 WS：未登录浏览走 NodeBB SSR/REST（架构 D8） */
	function isGuest() {
		return !state.uid;
	}

	// ---------- 连接生命周期 ----------

	// 连接进行期间到达的回调排队（防并发丢订阅），连接完成/失败后统一冲刷；
	// 回调内均有 state.centrifuge 判空，失败冲刷安全
	var pendingCbs = [];

	function ensureConnection(cb) {
		if (state.centrifuge) return cb();
		if (state.connecting) {
			pendingCbs.push(cb);
			return;
		}
		state.connecting = true;

		function done() {
			state.connecting = false;
			var queue = pendingCbs;
			pendingCbs = [];
			for (var i = 0; i < queue.length; i++) queue[i]();
		}

		loadSDK(function () {
			if (!window.Centrifuge) {
				done();
				return;
			}
			var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
			var endpoint = proto + '//' + location.host + '/connection/websocket';
			// getToken 而非静态 token：过期前 SDK 自动回调续期，2h TTL 不会把长会话踢下线
			state.centrifuge = new window.Centrifuge(endpoint, { getToken: fetchToken });
			state.centrifuge.on('connected', function () { log('WS 已连接'); });
			state.centrifuge.on('error', function (ctx) { log('WS 错误', ctx && ctx.message); });
			state.centrifuge.connect();
			cb();
			done();
		}, done); // SDK 加载失败：复位 connecting 并冲刷队列
	}

	function enterTopic(tid, data) {
		if (isGuest()) return; // 游客：纯 SSR，无实时层
		if (state.tid === tid && state.topicSub) return; // 已在该聊天室

		leaveTopic();
		state.tid = tid;
		// 历史无限加载初始化：直达中间楼层时 currentPage 即起点，向上递减到第 1 页封顶
		state.topicSlug = (data && data.slug) || '';
		state.pageFloor = Number(data && data.pagination && data.pagination.currentPage) || 1;
		state.noMoreHistory = !state.topicSlug || state.pageFloor <= 1;
		document.body.classList.add('ody-chatmode');
		markSelfPosts();
		ensureChatBar();

		ensureConnection(function () {
			if (!state.centrifuge || state.tid !== tid) return;

			// 消息流
			state.topicSub = state.centrifuge.newSubscription('topic:' + tid);
			state.topicSub.on('publication', onPublication);
			state.topicSub.subscribe();

			// typing + presence
			state.typingSub = state.centrifuge.newSubscription('typing:topic:' + tid);
			state.typingSub.on('publication', onTypingSignal);
			state.typingSub.on('subscribed', function () {
				// v5.7.4 实证：SubscribedContext 无 presence 字段，初始在线名单需主动拉取
				state.typingSub.presence().then(function (res) {
					var clients = (res && res.clients) || {};
					syncPresence(Object.keys(clients).map(function (k) { return clients[k]; }));
				}).catch(function () { /* 拉取失败不影响消息流 */ });
			});
			state.typingSub.on('join', function (ctx) { addPresence(ctx && ctx.info); });
			state.typingSub.on('leave', function (ctx) { removePresence(ctx && ctx.info); });
			state.typingSub.subscribe();

			// 多端同步（演示层仅日志；chat UI 后续迭代）
			state.userSub = state.centrifuge.newSubscription('user:' + state.uid);
			state.userSub.on('publication', function (ctx) {
				log('user 频道事件', ctx && ctx.data);
			});
			state.userSub.subscribe();

			startUiTimer();
			log('进入聊天室 topic:' + tid);
		});
	}

	function leaveTopic() {
		['topicSub', 'typingSub', 'userSub'].forEach(function (key) {
			var sub = state[key];
			if (sub) {
				// v5.7.4 实证：Subscription 无 remove() 方法，必须走 client.removeSubscription
				// （内部自动 unsubscribe；不清理注册表则重进 topic 时 newSubscription 直接 throw，实时层静默失效）
				try { state.centrifuge.removeSubscription(sub); } catch (e) { /* 防御 */ }
				state[key] = null;
			}
		});
		if (state.uiTimer) { clearInterval(state.uiTimer); state.uiTimer = null; }
		state.tid = 0;
		state.topicSlug = '';
		state.pageFloor = 0;
		state.historyLoading = false;
		state.noMoreHistory = false;
		state.typers = {};
		state.presence = {};
		state.unread = 0;
		document.body.classList.remove('ody-chatmode');
	}

	// ---------- 消息流处理 ----------

	function onPublication(ctx) {
		var payload = (ctx && ctx.data) || {};
		switch (payload.type) {
			case 'message.new': onNewMessage(payload.message); break;
			case 'message.edit': onEditMessage(payload.message); break;
			case 'message.delete': onMarkPost(payload.pid, true); break;
			case 'message.restore': onMarkPost(payload.pid, false); break;
			case 'message.purge': onRemovePost(payload.pid); break;
			case 'topic.purge': /* NodeBB 自己处理页面跳转 */ break;
			default: log('未知事件类型', payload.type);
		}
	}

	/** 新消息：追加气泡（去重 → 构造 → 滚动） */
	function onNewMessage(msg) {
		if (!msg || !msg.pid) return;

		// 身份+装饰缓存（uid → username/picture/decor；decor 由服务端 onPostSave 附带，
		// 后续 edit 等事件与气泡渲染复用；decor===null 表示"确认无装饰"，undefined 才走降级）
	if (msg.uid) {
		var prev = state.users[msg.uid] || {};
		state.users[msg.uid] = {
			username: msg.username || prev.username,
			picture: msg.picture || prev.picture,
			decor: (msg.decor !== undefined) ? msg.decor : prev.decor,
		};
	}

		var $topic = $('[component="topic"]');
		if (!$topic.length) return;

		// 双通道去重：NodeBB 原生 Socket.IO 可能已插入该楼层
		if ($('[data-pid="' + Number(msg.pid) + '"]').length) return;

		$topic.append(buildBubble(msg));
		maybeScroll();
	}

	/**
	 * 双通道去重（原生→自建方向）：原生楼层 DOM 插入完成（action:posts.loaded，含
	 * event:new_post / 无限滚动两路）时移除同 pid 的自建气泡。反向已由 onNewMessage
	 * 的全局 [data-pid] 去重覆盖——两条通道任一先到都不双份。
	 * （原生 removeAlreadyAddedPosts 只查 [component="post"]，不认 .ody-bubble，
	 *  不在此补齐则 Centrifugo 先到时必双份渲染）
	 */
	function onNativePostsLoaded(posts) {
		(posts || []).forEach(function (p) {
			if (p && p.pid) {
				$('.ody-bubble[data-pid="' + Number(p.pid) + '"]').remove();
			}
		});
	}

	/** 气泡 DOM：content 只走 textContent（XSS 防御，富文本由 NodeBB 原生层渲染） */
	function buildBubble(msg) {
		var who = state.users[msg.uid] || {};
		var self = Number(msg.uid) === state.uid;
		var time = new Date(Number(msg.timestamp) || Date.now())
			.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

		var avatar = who.picture
			? '<img class="ody-avatar" src="' + esc(encodeURI(who.picture)) + '" alt="">'
			: '<div class="ody-avatar ody-avatar-empty">' + esc(String(who.username || '?').charAt(0).toUpperCase()) + '</div>';

		var $b = $(
			'<article class="ody-bubble' + (self ? ' ody-self' : '') + '" data-pid="' + Number(msg.pid) + '" data-uid="' + Number(msg.uid) + '">' +
				'<div class="ody-avatar-wrap">' + avatar + '</div>' +
				'<div class="ody-body">' +
					'<div class="ody-meta">' +
						'<span class="ody-user"></span>' +
						'<time class="ody-time"></time>' +
						'<span class="ody-floor"></span>' +
					'</div>' +
					'<div class="ody-content"></div>' +
				'</div>' +
			'</article>'
		);
		$b.find('.ody-user').text(who.username || ('UID ' + msg.uid));
		$b.find('.ody-time').text(time);
		$b.find('.ody-floor').text('#' + (Number(msg.index) || ''));
		$b.find('.ody-content').text(String(msg.content || ''));

		// 身分组装饰：与楼层 / profile 同源同款（渲染原语来自 static/lib/decor.js 的 window.odyDecor）
		var decor = who.decor !== undefined ? who.decor
			: (window.odyDecor ? window.odyDecor.getDecor(msg.uid) : undefined);
		if (decor && window.odyDecor) {
			if (decor.name) window.odyDecor.applyNameFx($b.find('.ody-user')[0], decor.name);
			if (decor.badges && decor.badges.length) {
				decor.badges.forEach(function (bd) {
					var pill = window.odyDecor.renderPill(bd);
					if (pill) $b.find('.ody-time').before(pill); // 依次插在 time 前，保持 badge 顺序
				});
			}
		}
		return $b;
	}

	/** 编辑：兼容自建气泡与 Persona 楼层两种 DOM */
	function onEditMessage(msg) {
		if (!msg || !msg.pid) return;
		var $el = $('[data-pid="' + Number(msg.pid) + '"]');
		if (!$el.length) return;
		$el.find('.ody-content, [component="post/content"]').first().text(String(msg.content || ''));
		$el.addClass('ody-edited');
	}

	function onMarkPost(pid, deleted) {
		$('[data-pid="' + Number(pid) + '"]').toggleClass('ody-deleted', !!deleted);
	}

	function onRemovePost(pid) {
		$('[data-pid="' + Number(pid) + '"]').fadeOut(200, function () { $(this).remove(); });
	}

	// ---------- 滚动 / 未读 ----------

	function nearBottom() {
		return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM;
	}

	/** 贴底 → 平滑跟随；翻历史 → 不打扰，攒未读 */
	function maybeScroll() {
		if (nearBottom()) {
			window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
		} else {
			state.unread++;
			var $btn = $('.ody-newmsg');
			$btn.text(state.unread > 1 ? ('↓ ' + state.unread + ' 条新消息') : '↓ 新消息').show();
		}
	}

	// ---------- 历史无限加载（向上滚动拉更早一页，DC 式平铺补全） ----------

	/** 滚到顶部附近触发；加载中 / 已到底 / 不在聊天室时直接返回 */
	function onWindowScroll() {
		if (!state.tid || !state.topicSlug) return;
		if (state.historyLoading || state.noMoreHistory) return;
		if (window.scrollY > 60) return;
		loadOlderPage();
	}

	/** 拉上一页（NodeBB 现成分页 API）→ prepend 成气泡；失败静默停在当前深度 */
	function loadOlderPage() {
		if (state.pageFloor <= 1) { state.noMoreHistory = true; return; }
		state.historyLoading = true;
		showHistoryLoading(true);
		fetch('/api/topic/' + state.topicSlug + '?page=' + (state.pageFloor - 1), { credentials: 'same-origin' })
			.then(function (res) {
				if (!res.ok) throw new Error('page ' + res.status);
				return res.json();
			})
			.then(function (data) {
				if (!state.tid) return; // 加载期间已切页（ajaxify），丢弃本次结果
				var posts = (data && data.posts) || [];
				state.pageFloor = Number(data && data.pagination && data.pagination.currentPage) || (state.pageFloor - 1);
				if (!posts.length) { state.noMoreHistory = true; return; }
				prependHistory(posts);
				if (state.pageFloor <= 1) state.noMoreHistory = true;
			})
			.catch(function (err) {
				log('历史页加载失败（就此停在当前深度）：', err && err.message);
				state.noMoreHistory = true; // 防止反复砸失败接口
			})
			.then(function () {
				state.historyLoading = false;
				showHistoryLoading(false);
			});
	}

	/** prepend 到当前最顶消息之前；撑出的高度补回 scrollTop 保持视口不动；按 pid 与楼层/实时通道三方去重 */
	function prependHistory(posts) {
		var $anchor = $('[component="post"], .ody-bubble').first();
		if (!$anchor.length) return;
		var prevHeight = document.documentElement.scrollHeight;
		var added = 0;
		posts.forEach(function (p) {
			if (!p || !p.pid) return;
			if ($('[data-pid="' + Number(p.pid) + '"]').length) return; // 去重（与 onNewMessage 同款）
			// 历史页 user 走 getUserInfoForPosts 路径，p.user.odyDecor 即服务端注入的装饰
			if (p.user) {
				var prev = state.users[p.uid] || {};
				state.users[p.uid] = {
					username: p.user.username || prev.username,
					picture: p.user.picture || prev.picture,
					decor: (p.user.odyDecor !== undefined) ? p.user.odyDecor : prev.decor,
				};
			}
			$anchor.before(buildHistoryBubble(p));
			added++;
		});
		if (!added) return;
		// 视口不跳：把 prepend 撑出的高度补回 scrollTop（用户视角完全不动）
		window.scrollTo(0, window.scrollY + (document.documentElement.scrollHeight - prevHeight));
	}

	/** 历史气泡：与实时气泡同构；content 是 NodeBB 服务端渲染并消毒过的 HTML（与原生楼层 DOM 同级可信），故走 html() */
	function buildHistoryBubble(p) {
		var $b = buildBubble({
			pid: p.pid,
			uid: p.uid,
			timestamp: p.timestamp,
			index: p.index,
			content: '', // 实时通道 content 是原文走 text()；历史是已消毒 HTML，下行 html() 覆盖
		});
		$b.addClass('ody-rich').find('.ody-content').html(String(p.content || ''));
		return $b;
	}

	function showHistoryLoading(on) {
		$('.ody-histload').toggle(!!on);
	}

	// ---------- typing / presence ----------

	function onTypingSignal(ctx) {
		var data = (ctx && ctx.data) || {};
		if (!data.uid || Number(data.uid) === state.uid) return; // 自己的不提示
		state.typers[data.uid] = {
			username: data.username || state.users[data.uid] && state.users[data.uid].username || ('UID ' + data.uid),
			expireAt: Date.now() + TYPING_TTL,
		};
		renderTyping();
	}

	/** 回复框输入 → 节流发布 typing 心跳（订阅者可发布，服务端已鉴权） */
	function onComposerInput() {
		if (!state.typingSub || !state.tid) return;
		var now = Date.now();
		if (now - state.lastTypingSent < TYPE_DEBOUNCE) return;
		state.lastTypingSent = now;
		try {
			var p = state.typingSub.publish({
				uid: state.uid,
				username: (window.app && app.user && app.user.username) || '',
			});
			if (p && p.catch) p.catch(function () { /* typing 丢失无所谓 */ });
		} catch (e) { /* 防御 */ }
	}

	function syncPresence(list) {
		state.presence = {};
		(list || []).forEach(function (info) { addPresence(info); });
		renderPresence();
	}

	function addPresence(info) {
		if (!info) return;
		state.presence[info.client] = { uid: Number(info.user || 0) };
		renderPresence();
	}

	function removePresence(info) {
		if (!info) return;
		delete state.presence[info.client];
		renderPresence();
	}

	// ---------- UI（聊天室状态栏） ----------

	function ensureChatBar() {
		if (!$('.ody-histload').length) {
			$('[component="topic"]').before('<div class="ody-histload" style="display:none">正在加载更早的消息…</div>');
		}
		if ($('.ody-bar').length) return;
		$('[component="topic"]').after(
			'<div class="ody-bar">' +
				'<span class="ody-presence"></span>' +
				'<span class="ody-typing"></span>' +
				'<button class="ody-newmsg" type="button" style="display:none">↓ 新消息</button>' +
			'</div>'
		);
		$('.ody-newmsg').on('click', function () {
			state.unread = 0;
			$(this).hide();
			window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
		});
	}

	function renderTyping() {
		var now = Date.now();
		var names = [];
		Object.keys(state.typers).forEach(function (uid) {
			if (state.typers[uid].expireAt < now) delete state.typers[uid];
			else names.push(state.typers[uid].username);
		});
		var $el = $('.ody-typing');
		if (!$el.length) return;
		if (!names.length) { $el.text(''); return; }
		$el.text(names.slice(0, 3).join('、') + (names.length > 3 ? ' 等' : '') + ' 正在输入…');
	}

	function renderPresence() {
		var n = Object.keys(state.presence).length;
		$('.ody-presence').text(n > 0 ? ('在线 ' + n + ' 人') : '');
	}

	function startUiTimer() {
		if (state.uiTimer) clearInterval(state.uiTimer);
		state.uiTimer = setInterval(function () {
			renderTyping(); // 过期 typing 清理
		}, UI_TICK);
	}

	/** 给已有楼层标记"自己发的"（CSS 右侧气泡） */
	function markSelfPosts() {
		if (!state.uid) return;
		$('[component="post"]').each(function () {
			if (Number($(this).attr('data-uid')) === state.uid) {
				$(this).addClass('ody-self');
			}
		});
	}

	// ---------- 页面路由（ajaxify） ----------

	function onAjaxifyEnd() {
		var data = (window.ajaxify && ajaxify.data) || {};
		var tid = Number(data.tid);
		if (data.template === 'topic' && tid > 0 && $('[component="topic"]').length) {
			enterTopic(tid, data);
		} else {
			leaveTopic();
		}
	}

	/** NodeBB 的 hooks 全局在 app.js 里定义，插件脚本可能先加载 → 轮询等待 */
	function whenHooksReady(cb) {
		if (window.hooks) return cb();
		var tries = 0;
		var t = setInterval(function () {
			tries++;
			if (window.hooks) { clearInterval(t); cb(); }
			else if (tries > 80) clearInterval(t); // 8s 兜底放弃
		}, 100);
	}

	// ---------- 启动 ----------

	$(document).ready(function () {
		if (!window.jQuery) return; // NodeBB 环境必然有，防御非 NodeBB 页面

		state.uid = Number((window.app && app.user && app.user.uid) || 0);

		whenHooksReady(function () {
			hooks.on('action:ajaxify.end', onAjaxifyEnd);
			hooks.on('action:posts.loaded', function (data) {
				onNativePostsLoaded((data && data.posts) || []);
			});
			$(window).on('scroll', onWindowScroll); // 滚顶 → 无限加载历史
			// typing：topic 页任意输入框（快速回复/搜索框排除不了的代价可接受，节流兜底）
			$(document).on('input', 'textarea, input[type="text"]', function () {
				if (document.body.classList.contains('ody-chatmode')) onComposerInput();
			});
			onAjaxifyEnd(); // 处理首屏直刷进 topic 页的情况
		});
	});
})();
