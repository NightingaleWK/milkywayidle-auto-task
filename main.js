// ==UserScript==
// @name         Milky Way Idle - 自动任务
// @namespace    https://github.com/NightingaleWK
// @version      1.0.6
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

    /** 根据精确文本找任意可点击元素（含 div/span） */
    function findClickable(text) {
        for (const el of document.querySelectorAll('button, [role="tab"], [role="button"], a, div, span, li')) {
            if (el.textContent.trim() === text && el.offsetParent !== null) return el;
        }
        return null;
    }

    /** 安全点击 (兼容 React 事件系统) */
    function click(el) {
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.click();
        return true;
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
        // 优先：找侧边栏的技能图标（img 的 alt 包含 category）
        const sidebarImgs = document.querySelectorAll('img[alt*="' + category + '"]');
        for (const img of sidebarImgs) {
            const parent = img.closest('button, a, [role="button"], div');
            if (parent && parent.offsetParent) {
                log('通过图标导航到:', category);
                click(parent);
                await sleep(800);
                break;
            }
        }

        // 备用：点击文本（仅限侧边栏区域）
        if (sidebarImgs.length === 0) {
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

        // 方法1: 找 action icon 图片（资源项旁的图标，优先级最高）
        {
            const imgs = document.querySelectorAll('img[alt*="action"], [class*="action_icon"], [class*="actionIcon"]');
            for (const img of imgs) {
                const row = img.closest('div, li');
                if (row && row.textContent.includes(tabName) && row.offsetParent) {
                    log('点击资源(icon):', tabName);
                    click(img);
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

    // ─── 自动操作 ────────────────────────────────

    /** 处理单个任务: 前往 → 开始/添加到队列 */
    async function processOneTask(task) {
        if (isProcessing) return false;
        isProcessing = true;

        log(`处理任务: ${task.name} (${task.count}/${task.target})`);

        // 1. 点击"前往"
        click(task.btn);
        await sleep(800);

        // 2. 等待任务详情页加载（文本框出现目标数量）
        try {
            await waitFor(() => {
                const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
                for (const inp of inputs) {
                    if (inp.value == task.target || inp.value === '∞') return inp;
                }
                return null;
            }, 5000);
        } catch (e) {
            log('等待详情页超时，尝试直接匹配按钮');
        }

        // 3. 点击"添加到队列"/"立即开始"/"开始"
        try {
            const startBtn = await waitFor(() =>
                btnByContains('添加到队列') || btnByText('立即开始') || btnByText('开始'),
                3000);
            click(startBtn);
            knownTaskIds.add(task.id);
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
            click(unlimitedBtn);
            await sleep(300);

            // 点击 "立即开始" 或 "添加到队列"
            const startBtn = await waitFor(() => btnByText('立即开始') || btnByContains('添加到队列'), 3000);
            click(startBtn);
            isIdle = true;
            log('空闲挂机已启动');
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
        } else if (!isIdle) {
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
