# 影像片段授权证据与展陈终端发布

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可设置 `SOURCE_PORT`。来源使用进程内演练时钟，启动时处于 `booking`。用 `PUT /_source_clock?step=restrict` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `booking`、`restrict`、`late`、`restore`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料。

## 来源约定

编目页面的 `data-edition` 是成片版号，`data-part` 是被引用素材，`data-in`、`data-out` 为引用素材上以秒计的半开区间。`/catalog/links` 给出派生素材的区段对照，`at` 是派生开始点，对应原始素材上的同长度区段，不跨增速或倒放。`/exhibits/schedule` 的 `screen` 与 `slot` 指向一个编目位。
`/rights/entries` 包含随业务时间推进收到的许可修订，撤回即按其 `effective` 为所指许可缩短生效范围。授权只覆盖同一介质、用途及地点；`/rights/amendments` 返回涉及限定条款的正文。`/player/commands` 接受含 `screen, slot, sequence, action, edition` 的 JSON；`/player/receipts` 用相同身份回传收件、应用或失联。命令入口的响应仅表示请求到达，应用以设备回执为准。
