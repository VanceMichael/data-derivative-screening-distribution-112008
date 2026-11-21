# 影像片段授权证据与展陈终端发布

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start          # 合成来源，默认 http://127.0.0.1:4173
npm run curator    # 策展控制台，默认 http://127.0.0.1:4174
npm run demo       # 进程内走完 booking → restrict → late → restore 并打印结果
npm test
```

不同终端分别启动服务和执行独立来源测试。来源默认地址为 `http://127.0.0.1:4173`，可通过 `SOURCE_PORT` 设置端口，也接受通用的 `PORT`，同时设置时以 `SOURCE_PORT` 为准。`GET /health` 用于确认来源服务已就绪。来源使用进程内演练时钟，启动时处于 `booking`。用 `PUT /_source_clock?step=restrict` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `booking`、`restrict`、`late`、`restore`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料，并覆盖策展端的授权判断与发布状态机。

## 来源约定

编目页面的 `data-edition` 是成片版号，`data-part` 是被引用素材，`data-in`、`data-out` 为引用素材上以秒计的半开区间。`/catalog/links` 给出派生素材的区段对照，`at` 是派生开始点，对应原始素材上的同长度区段，不跨增速或倒放。`/exhibits/schedule` 的 `screen` 与 `slot` 指向一个编目位。
`/rights/entries` 包含随业务时间推进收到的许可修订，撤回即按其 `effective` 为所指许可缩短生效范围。授权只覆盖同一介质、用途及地点；`/rights/amendments` 返回涉及限定条款的正文。`/player/commands` 接受含 `screen, slot, sequence, action, edition` 的 JSON；`/player/receipts` 用相同身份回传收件、应用或失联。命令入口的响应仅表示请求到达，应用以设备回执为准。

## 策展端

`src/` 下的服务把编目、授权、展期和设备回执合成可执行的播出决定。所有对外时刻都带时区，内部按半开区间比较。

- **按实际原始区段判定授权**（`catalog.mjs`）：把成片里的每次素材引用沿 `/catalog/links` 递归展开到原始素材，再按秒段核对。派生素材对照有洞、成环或引用倒置时记录问题并冻结该版，不静默少算。
- **声音与画面各自取证**（`rights.mjs`）：同一素材的相邻有效区段可以首尾相接共同覆盖，但任一轨道缺证据就不会放行混合版本。授权需同时满足素材轴（秒）和时间轴（带时区的时刻）。
- **修订按生效时刻折叠**（`rights.mjs`）：`withdraw` 截断生效范围，`restrict` 自生效时刻起收窄场地/用途，`restore` 只撤销收窄、不会重开已撤回的授权。来源侧断档时沿用上一份资料并标记 `gaps`，只冻结受影响的安排。
- **限定条款**（`terms.mjs`）：只接受可复核的短语（场地、用途、起止时刻）。解释不了时把依赖该授权的安排冻结，并告诉策展人缺哪类许可。
- **发布台账**（`player.mjs`）：同一终端、同一编目位只接受递增序号。回执按序号记录；已确认状态只由更高序号的"已应用"回执推进。来源回执与本地命令动作或版号不一致时拒绝采信并标记冲突。失联（`offline`）只表示"停止未确认"，不能当作已停止；已撤回的版本即使留着旧上线回执也不算可播放。通道上已有同动作的命令在等确认时不再重复下发。
- **编排**（`curator.mjs`）：先同步来源（不发布），再按 `plan(at)` 决定每个编目位该 `on`、`swap`、`off` 还是 `none`。替换成片可以准备，但只有对应版授权完整且终端回执确认后才把编目位标为已更新。每次发出的命令、原因与时点都进入审计，`screenings(screen, slot)` 可按一次已发生的放映回看当时的素材与授权（下发时记录，或按回执时刻回算）。

### 接口

```text
GET  /health
POST /sync                                拉取来源资料，不发布
GET  /plan?at=<带时区时刻>                 只计算、不发送的发布计划
POST /reconcile?at=<带时区时刻>            按当前资料发布上线/下线指令
GET  /status?at=<带时区时刻>               编目位状态、许可依据、缺口与需人工联系的点
GET  /screenings?screen=P1&slot=feature   按一次已发生的放映回看
GET  /events?since=N                      审计事件增量
GET  /                                    策展人控制台
```

`at` 省略时使用服务时钟。`POST /sync` 之后 `/status` 只读缓存；阶段变化后需要再次 `POST /sync`。
策展控制台的“按状态发布”按钮等价于 `POST /reconcile`，只向合成来源发送指令，不传输任何影音。

### 状态字段

每个编目位在 `/status` 中给出：`covered`（授权是否完整）、`coveredUntil`（当前依据连续有效的截止时刻）、`nextChange`（已收到的修订将使其失效的时刻）、`basis`（当前依据的授权编号与时段）、`gaps`（逐段缺口及原因）、`frozen`（编目或条款问题）、`player.phase`（`on`、`off`、`starting-pending`、`stopping-pending`、`offline`、`playing-unlicensed`）、`updated`（替换版是否已获终端确认）。`attention` 汇总失联、停止未确认、回执冲突与授权缺口，供策展人逐点联系。
