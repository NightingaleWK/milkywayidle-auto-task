// ==UserScript==
// @name         Milky Way Idle - 自动任务
// @namespace    https://github.com/NightingaleWK
// @version      1.0.9
// @description  自动接取任务、添加到队列，空闲时挂机采摘小行星带
// @author       NightingaleWK
// @match        https://www.milkywayidle.com/game?characterId=*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ─── 配置 ───────────────────────────────────
    const CFG = {
        POLL_INTERVAL: 15000,        // 任务检查间隔 (ms)
        IDLE_LOCATION: '小行星带',    // 空闲挂机地点
        IDLE_TAB: '小行星带',         // 空闲挂机 tab
        IDLE_CATEGORY: '采摘',        // 空闲技能分类
        MAX_QUEUE: 4,                 // 最大队列数
        LOG_PREFIX: '[牛牛]',
    };

    // ─── 状态 ───────────────────────────────────
    let isIdle = false;               // 是否在空闲挂机
    let isProcessing = false;         // 是否正在处理任务
    let knownTaskIds = new Set();     // 已处理的 task id
    let busyUntil = 0;                // 近期刚开始活动的冷却窗口

    function log(...a) { console.log(CFG.LOG_PREFIX, ...a); }

    // ─── DOM 工具 ───────────────────────────────

    /** 根据精确文本找 button */
    function btnByText(text) {
        for (const b of document.querySelectorAll('button')) {
            if (b.textContent.trim() === text && b.offsetParent !== null) return b;
        }
        return null;
    }

    /** 根据包含文本找 button */
    function btnByContains(text) {
        for (const b of document.querySelectorAll('button')) {
            if (b.textContent.includes(text) && b.offsetParent !== null) return b;
        }
        return null;
    }

    function isVisible(el) {
        return !!(el && el.offsetParent !== null);
    }

    function describeElement(el) {
        if (!el) return 'null';
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const cls = typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, ' ') : '';
        return `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : ''}${text ? ` "${text}"` : ''}`;
    }

    function findButtonIn(root, text, contains = false) {
        if (!root || !root.querySelectorAll) return null;
        for (const b of root.querySelectorAll('button, [role="button"]')) {
            if (!isVisible(b)) continue;
            const label = b.textContent.trim();
            if (contains ? label.includes(text) : label === text) return b;
        }
        return null;
    }

    function findActionRoot(el) {
        if (!el) return document.body;
        return el.closest('[role="dialog"], [class*="modal"], [class*="panel"], [class*="card"], [class*="Card"], [class*="Dialog"], [class*="Panel"], form, main, section, article') || el.parentElement || document.body;
    }

    function logVisibleButtons(root, label) {
        if (!root || !root.querySelectorAll) return;
        const items = [];
        for (const b of root.querySelectorAll('button, [role="button"]')) {
            if (!isVisible(b)) continue;
            const text = b.textContent.trim().replace(/\s+/g, ' ');
            if (!text) continue;
            items.push(describeElement(b));
        }
        log(label, items);
    }

    /** 根据精确文本找任意可点击元素（含 div/span） */
    function findClickable(text) {
        const preferred = document.querySelectorAll('button, [role="tab"], [role="button"], a');
        for (const el of preferred) {
            if (el.textContent.trim() === text && isVisible(el)) return el;
        }

        for (const el of document.querySelectorAll('div, span, li')) {
            if (el.textContent.trim() !== text || !isVisible(el)) continue;
            const clickableParent = el.closest('button, [role="tab"], [role="button"], a');
            if (clickableParent) return clickableParent;
            if (el.parentElement && isVisible(el.parentElement)) return el.parentElement;
        }
        return null;
    }

    /** 安全点击 (兼容 React 事件系统) */
    function click(el) {
        if (!el) return false;
        log('点击目标:', describeElement(el));
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch (e) {}

        const rect = el.getBoundingClientRect();
        const x = Math.max(0, Math.floor(rect.left + rect.width / 2));
        const y = Math.max(0, Math.floor(rect.top + rect.height / 2));
        const target = document.elementFromPoint(x, y) || el;
        const eventTarget = target && (target === el || el.contains(target) || target.contains(el)) ? target : el;

        const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1 };
        if (typeof PointerEvent === 'function') {
            eventTarget.dispatchEvent(new PointerEvent('pointerover', base));
            eventTarget.dispatchEvent(new PointerEvent('pointerenter', base));
            eventTarget.dispatchEvent(new PointerEvent('pointerdown', base));
        }
        eventTarget.dispatchEvent(new MouseEvent('mouseover', base));
        eventTarget.dispatchEvent(new MouseEvent('mouseenter', base));
        eventTarget.dispatchEvent(new MouseEvent('mousedown', base));
        if (typeof PointerEvent === 'function') {
            eventTarget.dispatchEvent(new PointerEvent('pointerup', base));
            eventTarget.dispatchEvent(new PointerEvent('pointerout', base));
            eventTarget.dispatchEvent(new PointerEvent('pointerleave', base));
        }
        eventTarget.dispatchEvent(new MouseEvent('mouseup', base));
        eventTarget.dispatchEvent(new MouseEvent('click', base));
        if (eventTarget !== el) {
            el.dispatchEvent(new MouseEvent('click', base));
        }
        if (typeof el.click === 'function') el.click();
        return true;
    }

    async function clickAndConfirm(el, confirmFn, timeout = 2500) {
        if (!el) return false;
        click(el);
        try {
            await waitFor(confirmFn, timeout);
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 等待某条件成立 (轮询) */
    function waitFor(fn, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const r = fn();
                if (r) return resolve(r);
                if (Date.now() - start > timeout) return reject(new Error('timeout'));
                setTimeout(check, 150);
            };
            check();
        });
    }

    /** 短暂延迟 */
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ─── 任务检测 ────────────────────────────────

    /** 检查页面上是否有"前往"按钮(未完成的任务) */
    function hasPendingTasks() {
        return btnByText('前往') !== null;
    }

    /**
     * 扫描任务面板，返回所有待处理的任务
     * 每个任务返回: { btn, name, target, count }
     */
    function scanTasks() {
        const tasks = [];
        for (const btn of document.querySelectorAll('button')) {
            if (btn.textContent.trim() !== '前往' || btn.offsetParent === null) continue;

            // 向上遍历 DOM 找到包含"进度:"的卡片容器
            let card = btn.parentElement;
            for (let i = 0; i < 6; i++) {
                if (!card) break;
                if (card.textContent.includes('进度:')) break;
                card = card.parentElement;
            }
            if (!card || !card.textContent.includes('进度:')) continue;

            const text = card.textContent;
            // 提取进度: "进度: 0 / 149"
            const progMatch = text.match(/进度:\s*(\d+)\s*\/\s*(\d+)/);
            const current = progMatch ? parseInt(progMatch[1]) : 0;
            const target = progMatch ? parseInt(progMatch[2]) : 0;

            // 已完成的跳过
            if (progMatch && current >= target) continue;

            // 提取任务名："进度:"之前的文本，去掉按钮文字和面板标题
            const beforeProgress = text.split('进度:')[0].trim();
            // 去掉末尾的数字和"任务"等面板标题前缀
            let name = beforeProgress.replace(/[\d,]+$/g, '').trim();
            name = name.replace(/^任务\s*/, '').trim() || '未知任务';

            // 去重
            const id = `${name}|${target}`;
            if (knownTaskIds.has(id)) continue;

            tasks.push({ btn, name, target, count: current, id });
        }
        return tasks;
    }

    // ─── 导航操作 ────────────────────────────────

    /** 打开任务面板 */
    function openTaskPanel() {
        // 方法1: 点击侧边栏 "任务" 导航
        const navTask = findClickable('任务');
        if (navTask && navTask.closest('[class*="nav"], [class*="Nav"], nav, [class*="sidebar"]')) {
            return click(navTask);
        }

        // 方法2: 找包含"任务"文本且无子元素的容器
        for (const el of document.querySelectorAll('div, span, a')) {
            if (el.childElementCount === 0 && el.textContent.trim() === '任务' && el.offsetParent) {
                return click(el.parentElement || el);
            }
        }

        // 方法3: 找 "navigationBar.tasks" 图片的父元素
        for (const img of document.querySelectorAll('img[alt*="task"], img[src*="task"], img[src*="Task"]')) {
            const parent = img.closest('button, a, [role="button"]') || img.parentElement;
            if (parent) return click(parent);
        }

        return false;
    }

    /** 导航到指定技能分类下的 tab */
    async function navigateTo(category, tabName) {
        // 优先：找侧边栏的技能图标（svg/img 的 aria-label/alt 包含 category）
        const sidebarIcons = document.querySelectorAll(
            'img[alt*="' + category + '"], svg[aria-label*="' + category + '"]');
        for (const icon of sidebarIcons) {
            const parent = icon.closest('button, a, [role="button"], div');
            if (parent && parent.offsetParent) {
                log('通过图标导航到:', category);
                click(parent);
                await sleep(800);
                break;
            }
        }

        // 备用：点击文本（仅限侧边栏区域）
        if (sidebarIcons.length === 0) {
            const catEl = findClickable(category);
            if (catEl) {
                log('通过文本导航到:', category);
                click(catEl);
                await sleep(800);
            }
        }

        // 点击 tab
        await sleep(400);
        const tab = findClickable(tabName);
        if (tab && tab.offsetParent) {
            log('点击 tab:', tabName);
            click(tab);
            await sleep(600);
        } else {
            log('tab 未找到:', tabName);
        }

        // 等面板渲染后，点击资源项
        await sleep(500);
        let resourceClicked = false;

        // 方法1: 找 action icon（svg/img，资源项旁的图标，优先级最高）
        {
            const iconSelector = 'img[alt*="action"], svg[aria-label*="action"], [class*="action_icon"], [class*="actionIcon"]';
            const icons = document.querySelectorAll(iconSelector);
            for (const icon of icons) {
                const row = icon.closest('div, li, button');
                if (row && row.textContent.includes(tabName) && row.offsetParent) {
                    log('点击资源(icon):', tabName);
                    // 点击父容器或图标本身
                    click(row.tagName === 'BUTTON' ? row : (icon.closest('button') || icon));
                    resourceClicked = true;
                    break;
                }
            }
        }

        // 方法2: 找 button 含资源名（排除 tab 按钮）
        if (!resourceClicked) {
            for (const b of document.querySelectorAll('button')) {
                if (b.textContent.trim() === tabName && b.offsetParent
                    && !b.closest('[role="tablist"], [class*="tab"]')) {
                    log('点击资源(button):', tabName);
                    click(b);
                    resourceClicked = true;
                    break;
                }
            }
        }

        // 方法3: 找包含资源名的可点击容器
        if (!resourceClicked) {
            for (const el of document.querySelectorAll('div, span, li')) {
                const t = el.textContent.trim();
                if (t === tabName && el.offsetParent && el.children.length > 0
                    && !el.closest('[role="tablist"], [class*="tab"]')) {
                    log('点击资源(div):', tabName);
                    click(el);
                    resourceClicked = true;
                    break;
                }
            }
        }

        if (resourceClicked) await sleep(400);
    }

    /** 停止当前活动 */
    function stopActivity() {
        const stopBtn = btnByText('停止');
        if (stopBtn) {
            click(stopBtn);
            isIdle = false;
            log('已停止当前活动');
            return true;
        }
        return false;
    }

    function hasActiveActivity() {
        if (btnByText('停止')) return true;
        return false;
    }

    function markBusy(ms = 10000) {
        busyUntil = Math.max(busyUntil, Date.now() + ms);
    }

    // ─── 自动操作 ────────────────────────────────

    /** 处理单个任务: 前往 → 开始/添加到队列 */
    async function processOneTask(task) {
        if (isProcessing) return false;
        isProcessing = true;

        log(`处理任务: ${task.name} (${task.count}/${task.target})`);

        // 1. 点击"前往"
        click(task.btn);
        await sleep(800);

        // 2. 等待任务详情页加载（文本框出现剩余数量）
        const remaining = task.target - task.count;
        let detailInput = null;
        try {
            detailInput = await waitFor(() => {
                const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
                for (const inp of inputs) {
                    if (inp.value == remaining || (remaining <= 0 && inp.value === '∞')) return inp;
                }
                return null;
            }, 3000);
        } catch (e) {
            log('等待详情页超时，尝试直接匹配按钮');
        }

        // 3. 点击"添加到队列"/"立即开始"/"开始"
        try {
            const taskRoot = findActionRoot(detailInput);
            logVisibleButtons(taskRoot, '任务面板可见按钮:');
            const startBtn = await waitFor(() =>
                findButtonIn(taskRoot, '添加到队列', true) || findButtonIn(taskRoot, '立即开始') || findButtonIn(taskRoot, '开始')
                || btnByContains('添加到队列') || btnByText('立即开始') || btnByText('开始'),
                3000);
            log('准备点击任务开始按钮:', describeElement(startBtn));
            const confirmed = await clickAndConfirm(startBtn, () =>
                hasActiveActivity()
                || (!findButtonIn(taskRoot, '添加到队列', true) && !findButtonIn(taskRoot, '立即开始') && !findButtonIn(taskRoot, '开始')),
                2500);
            if (!confirmed) {
                log('点击开始后未确认进入队列，保留任务等待下轮重试:', task.name);
                isProcessing = false;
                return false;
            }
            knownTaskIds.add(task.id);
            markBusy();
            log(`已启动/加入队列: ${task.name}`);
            await sleep(500);
            isProcessing = false;
            return true;
        } catch (e) {
            log('未找到操作按钮:', e.message);
            isProcessing = false;
            return false;
        }
    }

    /** 开始空闲挂机 (小行星带 - 无限) */
    async function startIdle() {
        if (isIdle) return;
        log('开始空闲挂机:', CFG.IDLE_LOCATION);

        await navigateTo(CFG.IDLE_CATEGORY, CFG.IDLE_TAB);
        await sleep(500);

        // 点击 "Unlimited"
        try {
            const unlimitedBtn = await waitFor(() => btnByText('Unlimited'), 3000);
            const clicked = await clickAndConfirm(unlimitedBtn, () =>
                !!btnByText('立即开始') || !!btnByContains('添加到队列'),
                1500);
            await sleep(300);

            // 点击 "立即开始" 或 "添加到队列"
            const idleRoot = findActionRoot(unlimitedBtn);
            logVisibleButtons(idleRoot, '空闲面板可见按钮:');
            const startBtn = await waitFor(() =>
                findButtonIn(idleRoot, '立即开始') || findButtonIn(idleRoot, '添加到队列', true)
                || btnByText('立即开始') || btnByContains('添加到队列'),
                3000);
            log('准备点击空闲开始按钮:', describeElement(startBtn));
            const started = await clickAndConfirm(startBtn, () => hasActiveActivity(), 2500);
            if (clicked && started) {
                isIdle = true;
                markBusy();
                log('空闲挂机已启动');
            } else {
                log('空闲入口或开始按钮点击后未确认进入状态，稍后重试');
            }
        } catch (e) {
            log('启动空闲失败:', e.message);
        }
    }

    // ─── 主循环 ──────────────────────────────────

    async function tick() {
        // 如果正在处理任务，跳过
        if (isProcessing) {
            log('正在处理任务中，跳过本轮检查');
            return;
        }

        if (Date.now() < busyUntil) {
            log('活动冷却中，跳过空闲切换');
            return;
        }

        // 扫描任务
        const tasks = scanTasks();

        if (tasks.length > 0) {
            log(`发现 ${tasks.length} 个新任务`);

            // 停止空闲
            if (isIdle) stopActivity();
            await sleep(400);

            // 打开任务面板
            openTaskPanel();
            await sleep(600);

            // 逐个处理任务
            for (const task of tasks) {
                const ok = await processOneTask(task);
                if (ok) await sleep(300);
            }
            if (hasActiveActivity()) {
                isIdle = false;
                log('检测到当前已有活动，暂停空闲挂机切换');
                return;
            }
        } else if (!isIdle) {
            if (hasActiveActivity()) {
                isIdle = false;
                log('检测到当前已有活动，跳过空闲挂机');
                return;
            }
            // 没有任务且未挂机 → 启动挂机
            await startIdle();
        }
    }

    // ─── 启动 ────────────────────────────────────

    function init() {
        log('银河奶牛放置 - 自动任务脚本已加载');
        log(`检查间隔: ${CFG.POLL_INTERVAL / 1000}s | 空闲地点: ${CFG.IDLE_LOCATION}`);

        // 延迟启动，等页面完全渲染
        setTimeout(() => {
            tick();
            setInterval(tick, CFG.POLL_INTERVAL);
        }, 5000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 3000));
    } else {
        setTimeout(init, 3000);
    }
})();
