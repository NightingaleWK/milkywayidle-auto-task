# Milky Way Idle - 自动任务

Violentmonkey/Tampermonkey 用户脚本，自动化 Milky Way Idle 游戏的任务管理和空闲挂机。

## 功能

1. **自动任务**: 定时检查任务面板，自动点击"前往"→"添加到队列"
2. **空闲挂机**: 队列空闲时自动去小行星带无限采摘
3. **任务优先**: 新任务出现时停止挂机，处理完任务后恢复挂机
4. **去重**: 已处理的任务不会重复加入队列

## 安装

1. 安装 [Violentmonkey](https://violentmonkey.github.io/) 或 Tampermonkey 浏览器扩展
2. 打开 `main.js`，复制全部内容
3. 在扩展中新建脚本，粘贴并保存
4. 访问 https://www.milkywayidle.com/game 即可生效

## 配置

脚本顶部 `CFG` 对象可调整：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| POLL_INTERVAL | 15000 | 任务检查间隔 (毫秒) |
| IDLE_LOCATION | 小行星带 | 空闲挂机地点 |
| IDLE_TAB | 小行星带 | 空闲挂机标签页 |
| IDLE_CATEGORY | 采摘 | 技能分类 |
| MAX_QUEUE | 4 | 最大队列数 |

## 工作流程

```
每隔 15 秒:
  ├─ 有新任务? 
  │   ├─ 是 → 停止空闲 → 逐个处理任务
  │   └─ 否 → 检查是否在挂机
  │       └─ 否 → 导航到小行星带 → Unlimited → 立即开始
  └─ 处理任务中 → 跳过本轮
```

## 日志

按 F12 打开浏览器控制台，过滤 `[牛牛]` 查看运行日志。
