# 许可证原文领取

法务离线交付要求：每个实际安装的 npm 组件都必须附带许可证原文，而不能只抄 registry 的 `license` 字段。本模块从**授权镜像**按锁文件范围领取证据，全程不安装、不执行包内脚本。

## 范围与边界

- 领取范围只来自输入锁文件（`lockfileVersion=3`）的 `packages` 条目，不解析依赖树、不自动升级、不接受任意包名输入；
- 同名不同版本、npm alias（安装名 ≠ 真实包名）、嵌套安装路径、workspace `link` 各自有独立身份键，互不混淆；
- 来源准入只承认授权镜像主机；演练模式强制回环地址，非 http(s) 协议直接拒绝；
- 镜像的 `dist-tags` 是可变标签，只读取锁定版本的 `dist`，标签漂移只记录、不改变领取对象。

## 三重核对

每个可领取组件依次核对：

1. 锁文件的 `integrity`（SRI，支持 sha256/384/512，常量时间比较）自身可解析；
2. 镜像元数据锁定版本段的 `dist.integrity` 与 `dist.tarball` 和锁文件一致；
3. 实际下载的归档字节通过锁文件完整性约束校验。

任一环不符即终止该组件并给出显式状态，其他组件不受影响。

## 状态清单

| 状态 | 含义 |
| --- | --- |
| `collected` | 归档可信，至少找到一份许可证原文并入库 |
| `missing-license` | 归档可信但归档内没有许可证文件 |
| `digest-mismatch` | 锁文件约束、元数据摘要或实际字节核对失败 |
| `source-denied` | resolved 地址不在授权来源范围 |
| `unresolved` | 引用无法解析（约束损坏、缺字段、归档格式错误等） |
| `fetch-failed` | 授权来源请求失败（404、网络、超时） |
| `workspace-link` | 本地软链，不产生外部领取 |

## 资料库与去重

输出目录结构：

```
<out>/
  index.json      # 归档/证据对象索引（原子写入，启动对账自愈）
  manifest.json   # 组件 -> 原文证据的清单，最后写入
  archives/       # 按完整性约束键去重的已校验 tarball 字节
  blobs/          # 按 sha256 内容寻址的许可证/NOTICE 原文
```

- 许可证与 NOTICE 分别归类，同名文件出现在嵌套目录时保留其归档内相对路径；
- 同一份原文被多个组件引用时只存一个 blob，清单中多次引用同一 sha256；
- 已校验归档与“校验失败结论”（负缓存）都会复用：重复领取不重新下载任何字节；
- 所有写入先落 `*.tmp` 再 `rename`，清单最后写入；进程被杀死后重开自动清理临时文件与孤儿对象，索引永不指向未完整保存的资料。

## 安全约束

- tar 只在内存中解析（自带最小读取器，校验 ustar checksum，支持 GNU longname/pax），不向工作目录解压任何路径；
- 不可信的 `package.json` 只做字段解析，绝不 `require`/`import`；
- 安装脚本（preinstall/install/postinstall 等）只登记其存在，`scriptsExecuted` 恒为 false。

## 用法

```sh
# 直接从镜像 /lock 领取
node src/license-cli.mjs --base http://127.0.0.1:PORT --out ./output/licenses

# 或传入本地锁文件
node src/license-cli.mjs --lock ./package-lock.json --base http://127.0.0.1:PORT --out ./output/licenses
```

退出码：`0` 全部组件无终态失败；`2` 清单中存在失败状态（适合流水线卡点）；`1` 运行级错误。

服务形态下另有 `GET /collect`（触发领取）、`GET /manifest`（读取清单）、`GET /evidence/<sha256>`（回读原文字节）。

## 本地演练

```sh
npm run license-demo
```

演示使用 `fixtures/source.mjs` 的本地回环镜像，覆盖别名、版本共存、嵌套许可证、冲突摘要、缺许可证、来源拒绝、无法解析与崩溃恢复，不访问任何真实公共仓库。
