#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { pipeline } from 'node:stream/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"

function run(command, args, { capture = false, input, env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root, env,
      stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
    })
    let output = ''
    if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolvePromise(output.trim()) : reject(new Error(`${command} 执行失败（退出码 ${code}）`)))
    if (input !== undefined) {
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
      child.stdin.end(input)
    }
  })
}

function finished(child, name) {
  return new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`${name} 失败（退出码 ${code}）`)))
  })
}

async function exportImage(image, archive) {
  const save = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'inherit'] })
  const gzip = spawn('gzip', ['-1'], { stdio: ['pipe', 'pipe', 'inherit'] })
  try {
    await Promise.all([
      finished(save, '导出镜像'), finished(gzip, '压缩镜像'),
      pipeline(save.stdout, gzip.stdin), pipeline(gzip.stdout, createWriteStream(archive)),
    ])
  } catch (error) {
    save.kill()
    gzip.kill()
    throw error
  }
}

async function main() {
  let envFile = join(root, '.env')
  let dryRun = false
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true
    else if (args[i] === '--env-file' && args[i + 1]) envFile = resolve(args[++i])
    else if (args[i] === '--help') {
      console.log('用法：node scripts/deploy.mjs [--env-file 路径] [--dry-run]\n默认读取项目根目录 .env；--dry-run 仅检查配置和显示计划，不连接服务器。')
      return
    } else throw new Error(`未知参数或缺少参数值：${args[i]}`)
  }
  let fileEnv = {}
  try { fileEnv = parseEnv(await readFile(envFile, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const config = { ...fileEnv, ...process.env }
  const required = name => {
    if (!config[name]) throw new Error(`缺少 ${name}，请参考 .env.example 在 .env 中填写部署配置。`)
    return config[name]
  }
  const host = required('DEPLOY_HOST')
  const user = required('DEPLOY_USER')
  const remoteDir = required('DEPLOY_DIR')
  const password = config.DEPLOY_PASSWORD || ''
  const port = config.DEPLOY_PORT || '22'
  const image = config.DEPLOY_IMAGE || 'iptv:personal'
  const service = config.DEPLOY_SERVICE || 'iptv'
  const platform = config.DEPLOY_PLATFORM || 'linux/amd64'
  const sudo = config.DEPLOY_SUDO || 'false'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) throw new Error('DEPLOY_HOST 请填写主机名、IPv4 或 SSH 主机别名。')
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user)) throw new Error('DEPLOY_USER 格式错误。')
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('DEPLOY_PORT 必须为 1–65535。')
  if (!(remoteDir.startsWith('/') || remoteDir.startsWith('~/'))) throw new Error('DEPLOY_DIR 必须为绝对路径或 ~/ 开头的路径。')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(image)) throw new Error('DEPLOY_IMAGE 格式错误。')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service)) throw new Error('DEPLOY_SERVICE 格式错误。')
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('DEPLOY_PLATFORM 支持 linux/amd64 或 linux/arm64。')
  if (!['true', 'false'].includes(sudo)) throw new Error('DEPLOY_SUDO 必须为 true 或 false。')
  const target = `${user}@${host}`
  const docker = sudo === 'true' ? 'sudo -n docker' : 'docker'
  const cd = remoteDir.startsWith('~/') ? `cd -- "$HOME"/${quote(remoteDir.slice(2))}` : `cd -- ${quote(remoteDir)}`
  console.log(`部署：${image} (${platform}) → ${target}:${remoteDir}，服务 ${service}`)
  if (dryRun) {
    console.log(`认证：${password ? '使用 .env / 环境变量中的密码' : '使用 SSH 密钥或 SSH Agent'}`)
    console.log(`计划：远程预检 → 构建 → 导出压缩 → SCP 上传 → 加载镜像 → 重建服务 → 检查状态 → 清理临时文件。\n远程 Compose 的 services.${service}.image 必须为 ${image}。`)
    return
  }
  const localTemp = await mkdtemp(join(tmpdir(), 'iptv-deploy-'))
  let remoteTemp
  const sshEnv = { ...process.env }
  const common = ['-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'StrictHostKeyChecking=accept-new']
  if (password) {
    // OpenSSH 通过临时 askpass 程序取密码，密码只通过子进程环境传递。
    const askpass = join(localTemp, 'askpass.sh')
    const code = 'if (!/password/i.test(process.argv[1] || "")) process.exit(1); process.stdout.write(process.env.DEPLOY_PASSWORD || "")'
    await writeFile(askpass, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(code)} "$1"\n`, { mode: 0o700 })
    Object.assign(sshEnv, { DEPLOY_PASSWORD: password, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0' })
    common.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1')
  } else common.push('-o', 'BatchMode=yes')
  const remote = (script, capture = false) => run('ssh', [...common, '-p', port, target, 'bash -se'], { input: script + '\n', capture, env: sshEnv })
  try {
    console.log('\n[1/6] 检查本地 Docker 和远程 Compose…')
    await run('docker', ['info'], { capture: true })
    await run('docker', ['buildx', 'version'], { capture: true })
    const compose = JSON.parse(await remote(`${docker} info >/dev/null\n${cd}\n${docker} compose config --format json`, true))
    if (compose.services?.[service]?.image !== image) throw new Error(`请先将服务器 Compose 的 services.${service}.image 设为 ${image}（当前为 ${compose.services?.[service]?.image ?? '未配置'}）。`)
    console.log('\n[2/6] 构建镜像…')
    await run('docker', ['buildx', 'build', '--platform', platform, '-t', image, '--load', '--progress=plain', '.'])
    const archive = join(localTemp, 'image.tar.gz')
    console.log('\n[3/6] 导出并压缩镜像…')
    await exportImage(image, archive)
    console.log('\n[4/6] 上传镜像…')
    remoteTemp = await remote('mktemp -d /tmp/iptv-deploy-XXXXXXXX', true)
    if (!/^\/tmp\/iptv-deploy-[a-zA-Z0-9]+$/.test(remoteTemp)) throw new Error('服务器返回的临时目录格式异常。')
    await run('scp', [...common, '-P', port, archive, `${target}:${remoteTemp}/image.tar.gz`], { env: sshEnv })
    console.log('\n[5/6] 加载镜像并重建服务…')
    await remote(`${cd}\n${docker} load -i ${quote(remoteTemp + '/image.tar.gz')}\n${docker} compose up -d --no-deps --no-build --pull never --force-recreate ${quote(service)}`)
    console.log('\n[6/6] 检查容器状态…')
    await remote(`${cd}
container=$(${docker} compose ps -a -q ${quote(service)})
[ -n "$container" ] || { echo '没有找到部署后的容器' >&2; exit 1; }
for attempt in $(seq 1 30); do
  status=$(${docker} inspect --format '{{.State.Status}}' "$container")
  health=$(${docker} inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
  if [ "$status" = running ] && { [ "$health" = healthy ] || { [ "$health" = none ] && [ "$attempt" -ge 3 ]; }; }; then
    ${docker} compose ps ${quote(service)}
    ${docker} compose logs --tail=30 ${quote(service)}
    exit 0
  fi
  if [ "$status" = exited ] || [ "$status" = dead ] || [ "$status" = restarting ] || [ "$health" = unhealthy ]; then break; fi
  sleep 2
done
${docker} compose logs --tail=80 ${quote(service)}
echo '容器未正常运行或健康检查未通过，请检查以上日志。' >&2
exit 1`)
    console.log('\n部署完成。容器状态检查通过；频道是否能播放需在后台确认。')
  } finally {
    if (remoteTemp && /^\/tmp\/iptv-deploy-[a-zA-Z0-9]+$/.test(remoteTemp)) {
      await remote(`rm -rf -- ${quote(remoteTemp)}`).catch(error => console.error(`远程临时文件清理失败：${error.message}；路径：${remoteTemp}`))
    }
    await rm(localTemp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(`\n部署失败：${error.message}`); process.exitCode = 1 })
