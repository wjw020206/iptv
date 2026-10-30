# 腾讯云 COS 订阅上传

推荐直接在管理后台配置，无需编辑环境变量或设置系统计划任务。

## 后台配置

1. 启动更新后的项目，进入管理后台的「设置 → COS 订阅」。
2. 填写 SecretId、SecretKey、完整存储桶名称（如 `my-tv-1250000000`）、地域（如 `ap-shanghai`）和文件路径（如 `iptv.m3u`）。建议使用仅允许写入目标对象的子账号凭据。
3. 填写 **IPTV 服务器公网地址**，例如 `http://实际公网IP:1905`。这不是 COS 地址，不带密码、目录或查询参数。
4. 选择配置档和标准版 / 兼容版 / 全代理版订阅。留空配置档使用默认档。上传会保留后台的排序、隐藏和分组设置，自动使用当前服务的访问密码。
5. 等待频道生成后，点击「保存并立即上传」。页面显示最近尝试、最近成功、失败原因和可复制的电视订阅地址。
6. 需要自动上传时勾选「启用定时上传」，设置间隔（1–10080 分钟，默认 10 分钟），点击「保存配置」。

定时设置保存即生效，无需重启。首次定时上传在一个间隔后进行；后台每 15 秒检查一次到期任务。关闭开关后不再启动新的定时上传。服务重启后继续使用保存的配置和下次执行时间，已到期则尝试上传。上传期间禁止重复触发或修改配置；失败会记录原因，等待下一个间隔重试。

定时上传只同步已有清单，不触发频道抓取。上传前校验 M3U，空列表、错误响应和未展开占位符不会覆盖 COS 文件。IPTV 服务需要持续运行，COS 只分发列表。

## COS 读取设置

在 COS 控制台为目标对象配置读取权限。电视需要长期固定地址时，可以将该对象设为公有读，写入仍需鉴权；其他对象保持私有。本功能不会自动修改 ACL。私有对象的临时签名 URL 会过期，不适合作为长期固定订阅。

电视填入页面生成的 HTTPS 地址，例如：

```text
https://my-tv-1250000000.cos.ap-shanghai.myqcloud.com/iptv.m3u
```

清单包含播放所需的服务访问凭据，请妥善保管订阅地址。上传使用 `text/plain; charset=utf-8` 和 `Cache-Control: no-cache, max-age=0`；播放器仍可能自行缓存列表，请开启定时刷新。网页跨域导入时，需在 COS 桶配置允许对应来源 GET/HEAD 的 CORS。

## 更换 IP 或迁移

服务器 IP 改变后，在本页修改公网地址，点击「保存并立即上传」。保留存储桶和文件路径，电视里的 COS 地址就不变；电视刷新订阅后才会使用新地址。公网 IP 不会自动检测。

配置与密钥保存在持久化数据目录的 `cos-config.json`，文件权限为仅当前用户读写；密钥不通过后台接口回显，输入框留空保存会保留已有值。上传状态保存在 `cos-state.json`。

迁移服务器时，除原 IPTV 数据外，还需迁移 `cos-config.json`（当前「备份迁移」不包含它），启动后更新公网地址并手动上传。已有官方 Docker 镜像没有本次改动，Docker 部署需用当前源码重新构建镜像。

## 打包镜像并部署到服务器

项目已有 Dockerfile，本次改动可直接打包。以服务器是常见的 x86_64 架构为例，在本机安装并启动 Docker 后，从项目目录执行：

```bash
docker buildx build --platform linux/amd64 -t iptv:cos --load .
docker save iptv:cos | gzip > iptv-cos.tar.gz
```

如果服务器是 ARM64，将平台改为 `linux/arm64`。镜像构建会安装依赖和 Chromium。COS 密钥、配置和本地数据已从构建上下文排除，不会打进镜像。

把 `iptv-cos.tar.gz` 上传到服务器后，进入准备存放 IPTV 数据的目录执行：

```bash
docker load -i iptv-cos.tar.gz
docker run -d --name iptv --init --restart unless-stopped \
  -p 1905:1905 \
  -v "$PWD/data:/iptv/data" \
  -e mpass=替换为你的访问密码 \
  -e mbrowserConcurrency=1 \
  iptv:cos
```

在云服务器安全组开放实际访问端口，通过 `http://服务器IP:1905/你的访问密码/admin` 进入后台。COS 配置和定时任务都在后台管理，配置保存到挂载的 `data` 目录，不需要另一个上传容器或 cron。更换镜像时继续挂载原数据目录。

也可直接把源码上传到服务器，执行 `docker build -t iptv:cos .` 后运行上述容器命令。当前修改尚未发布到官方镜像，使用 `akiralereal/iptv:latest` 不会自动包含此功能。

## 旧命令行方式

仍保留 `pnpm sync:cos` 命令。它单独读取 `cos.env`，与后台配置独立；后台不会自动导入 `cos.env`。建议改用后台后移除此前创建的 cron 任务，避免两套配置覆盖同一文件。

命令行配置示例：

```bash
cp cos.env.example cos.env
chmod 600 cos.env
# 编辑 cos.env 后执行（Node.js 22+）
pnpm sync:cos
```
