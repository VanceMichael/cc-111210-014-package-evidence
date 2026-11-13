# 授权包镜像

## 锁文件入口

`GET /lock` 提供 npm `lockfileVersion=3` 的锁文件，覆盖以下边界：

- 同名不同版本共存：`fixture-lib` 的 1.0.0 与 1.1.0 同时被锁定；
- npm alias：`node_modules/renamed` 的安装名与真实包名（`fixture-lib`）不同；
- 嵌套安装：`node_modules/host/node_modules/fixture-lib`；
- workspace 引用：`node_modules/local` 为 `link: true` 的本地软链，不产生外部领取。

## 元数据入口

- `GET /pkg-metadata/<name>` 返回 registry 风格的单包文档，`dist-tags.latest` 故意指向与锁定版本不同的值。领取逻辑只读取锁定版本的 `versions[<locked>].dist`，可变标签不改变领取对象，标签漂移只被记录进清单。
- `GET /metadata` 为旧版查看入口保留的聚合视图。

## 归档入口与冲突演练

`GET /tar/<name>-<version>.tgz` 返回真实 gzip + ustar 归档：

- 归档含 `package.json`、可能位于嵌套目录的许可证（如 `docs/LICENSE`）以及独立的 `NOTICE`；NOTICE 与许可证是不同资料；
- 安装脚本仅作为 `package.json` 中不可执行的元数据存在，领取过程绝不执行；
- `conflict-pkg-1.0.0.tgz` 服务被污染字节，与锁文件中合法的完整性约束冲突；
- `drift-pkg` 的归档字节与锁文件约束一致，但镜像元数据的 `dist.integrity` 被篡改；
- `no-license-pkg` 是可信归档但不含任何许可证文件；
- `vanished-1.0.0.tgz` 不在路由中，模拟 404 领取失败；
- `denied-pkg` 的 resolved 指向回环以外主机，模拟来源不允许；
- `unresolved-pkg` 持有无法解析的完整性约束。

镜像只在本地回环监听，禁止依赖真实公共仓库进行演练。所有归档与摘要均为本地合成数据。
