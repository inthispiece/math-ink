# PDF 回归材料

`mixed-math.pdf` 是本项目生成的五页合成材料：中英文与公式、`/Rotate 90` 页面、扫描图片、空白页、矩阵与多行数学文字。`encrypted.pdf` 是同一材料的加密副本，仅用于验证拒绝导入，测试密码为 `fixture-password`。`owner-encrypted.pdf` 的用户密码为空、所有者密码为 `fixture-owner`，验证文件即使能直接打开也按加密文件拒绝导入。

材料没有个人笔记或服务凭据。内嵌 Noto Sans SC 的许可见仓库 `platforms/upstreams.lock.json` 中固定字体及对应许可文件；图形、文字和页序由测试生成。页码、尺寸、旋转与输出图片都需核对，不能只判断文件下载成功。
