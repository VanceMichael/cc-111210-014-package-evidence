# 授权包镜像
`/lock` 提供npm lockfileVersion=3，含同版本包、别名引用及workspace链接。`/metadata` 故意将latest指向不同版本，固定版本1.0.0的dist摘要与`/package.tgz`一致。`/corrupt.tgz` 模拟字节污染。
归档为真实gzip+ustar，含package.json、嵌套许可证与NOTICE；安装脚本仅作为不可执行的元数据存在。当前查看入口列出锁定组件和元数据，不下载或提取证据。镜像只在本地回环监听，禁止依赖真实公共包进行演练。
