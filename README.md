# 离线采集组件的许可证资料领取

本项目用于授权资料接入的单次查看与接收留存，以及离线交付所需的 npm 组件许可证原文领取，使用 Node.js 22。来源协议见 `docs/source-contract.md`，许可证领取的范围、核对与状态定义见 `docs/license-collection.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm run license-demo
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm run license-demo` 在本地回环镜像上演示许可证原文领取：覆盖 npm alias、同名版本共存、嵌套许可证、摘要冲突、缺许可证、来源拒绝、无法解析的引用以及崩溃恢复，不访问真实公共仓库。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

`GET /collect` 仅按镜像锁文件指明的组件领取许可证原文并产出 `manifest.json` 清单与内容寻址资料库，`GET /manifest` 读取清单，`GET /evidence/<sha256>` 回读许可证/NOTICE 原文字节。命令行形态为 `npm run license:collect -- --lock <锁文件> --base <镜像地址> --out <资料库目录>`；清单含失败状态时退出码为 2。

`src/connector.mjs` 解释单次来源响应与锁文件条目（别名/嵌套/workspace 区分），`src/integrity.mjs` 解析并核对 SRI 完整性约束，`src/tar-reader.mjs` 只读内存地解析 ustar 归档，`src/license-extract.mjs` 分类许可证与 NOTICE，`src/evidence-library.mjs` 管理内容寻址与原子写入的资料库，`src/collector.mjs` 编排三重核对与状态机，`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。`test/` 下的测试验证协议原语、状态矩阵、去重复用、崩溃自愈与服务边界。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
