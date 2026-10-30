import { mergePlaylistLines } from './multiLinePlaylist.js'

/** 下载本机已经应用配置档的订阅，替换本机前缀后再上传；不读取内部模板文件。 */
export function validateCosEnv(env) {
  for (const key of ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION', 'COS_PUBLIC_BASE_URL']) {
    if (!env[key]?.trim()) throw new Error(`缺少配置：${key}`)
  }
  const source = new URL(env.COS_SOURCE_URL || 'http://127.0.0.1:1905/interface.m3u')
  if (source.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(source.hostname) || source.username || source.password) {
    throw new Error('COS_SOURCE_URL 必须是本机 http://127.0.0.1 或 http://localhost 的订阅地址')
  }
  const base = new URL(env.COS_PUBLIC_BASE_URL)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('COS_PUBLIC_BASE_URL 应为 IPTV 公网地址（含端口），不带密码路径、查询参数或目录')
  }
  if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(base.hostname)) {
    throw new Error('COS_PUBLIC_BASE_URL 不能使用本机回环地址')
  }
  const key = env.COS_KEY || 'iptv.m3u'
  if (!key.endsWith('.m3u') || key.startsWith('/')) throw new Error('COS_KEY 应为不以 / 开头、以 .m3u 结尾的对象路径')

  return { source, base, key }
}

export async function syncCos(env = process.env, { fetchImpl = fetch, upload } = {}) {
  const { source, base, key } = validateCosEnv(env)

  let response
  try {
    response = await fetchImpl(source, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
  } catch {
    throw new Error('本机订阅请求失败，请确认服务已启动、端口正确且未超时')
  }
  if (!response.ok) throw new Error(`本机订阅请求失败：HTTP ${response.status}`)
  const content = (await response.text()).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!/^#EXTM3U(?:\s|$)/.test(content) || !/^#EXTINF:/m.test(content) || content.includes('${replace}')) {
    throw new Error('订阅不是有效的非空 M3U，保留 COS 原文件')
  }
  // 本机请求在 interfaceStr 中固定使用请求 Host，不受 mhost 配置影响。
  // 同时替换频道、台标、EPG、回看等本项目地址，保留密码或用户令牌路径。
  const rewritten = content.replaceAll(`${source.origin}/`, `${base.origin}/`)
  const body = env.COS_MERGE_LINES === 'true' ? mergePlaylistLines(rewritten) : rewritten
  const params = {
    Bucket: env.COS_BUCKET,
    Region: env.COS_REGION,
    Key: key,
    Body: Buffer.from(body, 'utf8'),
    ContentType: 'text/plain; charset=utf-8',
    CacheControl: 'no-cache, max-age=0',
    ContentDisposition: 'inline; filename="iptv.m3u"',
  }
  if (!upload) {
    const { default: COS } = await import('cos-nodejs-sdk-v5')
    const client = new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY, Timeout: 30_000 })
    upload = params => new Promise((resolve, reject) => {
      client.putObject(params, (error, result) => error ? reject(error) : resolve(result))
    })
  }
  try {
    await upload(params)
  } catch {
    throw new Error('COS 上传失败，请检查密钥、桶名称、地域、写入权限和网络')
  }
  return { key, bytes: params.Body.length }
}
