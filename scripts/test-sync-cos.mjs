import assert from 'node:assert/strict'
import http from 'node:http'
import { syncCos } from './sync-cos.mjs'

let status = 200
let content
const server = http.createServer((req, res) => {
  assert.equal(req.url, '/u/test-token/interface.m3u?profile=tv&relay=1')
  res.writeHead(status)
  res.end(content || `#EXTM3U x-tvg-url="http://${req.headers.host}/u/test-token/playback.xml"\n#EXTINF:-1 tvg-logo="http://${req.headers.host}/u/test-token/logos/tv.png",测试\nhttp://${req.headers.host}/u/test-token/relay/test.m3u8\n#EXTINF:-1,直连\nhttps://cdn.example/live.m3u8\n`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const env = {
  COS_SECRET_ID: 'test', COS_SECRET_KEY: 'test', COS_BUCKET: 'test-123', COS_REGION: 'ap-shanghai',
  COS_PUBLIC_BASE_URL: 'http://203.0.113.10:1905',
  COS_SOURCE_URL: `http://127.0.0.1:${server.address().port}/u/test-token/interface.m3u?profile=tv&relay=1`,
}
let uploads = []
const upload = async params => { uploads.push(params) }
try {
  await syncCos(env, { upload })
  const first = uploads[0]
  const body = first.Body.toString()
  assert.ok(body.includes('http://203.0.113.10:1905/u/test-token/relay/test.m3u8'))
  assert.ok(body.includes('http://203.0.113.10:1905/u/test-token/playback.xml'))
  assert.ok(body.includes('http://203.0.113.10:1905/u/test-token/logos/tv.png'))
  assert.ok(body.includes('https://cdn.example/live.m3u8'))
  assert.ok(!body.includes('127.0.0.1'))
  assert.equal(first.Key, 'iptv.m3u')
  assert.equal(first.ContentType, 'text/plain; charset=utf-8')
  assert.equal(first.CacheControl, 'no-cache, max-age=0')

  await syncCos({ ...env, COS_PUBLIC_BASE_URL: 'http://203.0.113.20:1905' }, { upload })
  assert.equal(uploads[1].Key, first.Key)
  assert.ok(uploads[1].Body.toString().includes('http://203.0.113.20:1905/u/test-token/relay/test.m3u8'))
  for (const invalid of ['获取失败', '<html>error</html>', '#EXTM3U\n', '#EXTM3U\n#EXTINF:-1,坏地址\n${replace}/123\n']) {
    content = invalid
    await assert.rejects(syncCos(env, { upload }), /有效的非空 M3U/)
  }
  status = 403
  await assert.rejects(syncCos(env, { upload }), /HTTP 403/)
  assert.equal(uploads.length, 2, '失败时不应覆盖 COS')
  status = 200
  content = '#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV1综合\nhttps://cdn.example/one.m3u8\n#EXTINF:-1 group-title="央视频",CCTV1综合\nhttps://cdn.example/two.m3u8\n'
  await syncCos(env, { upload })
  assert.equal((uploads.at(-1).Body.toString().match(/^#EXTINF:/gm) || []).length, 2, '默认仍为标准 M3U')
  await syncCos({ ...env, COS_MERGE_LINES: 'true' }, { upload })
  assert.equal(uploads.at(-1).Body.toString(), '#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV1综合\nhttps://cdn.example/one.m3u8\nhttps://cdn.example/two.m3u8\n')
  content = undefined
  await assert.rejects(syncCos(env, { upload: async () => { throw new Error('secret') } }), /COS 上传失败/)
  await assert.rejects(syncCos({ ...env, COS_PUBLIC_BASE_URL: 'http://localhost:1905' }, { upload }), /回环地址/)
  console.log('COS 同步测试通过：地址迁移、令牌/配置档、直连保留、错误内容保护、上传失败')
} finally {
  await new Promise(resolve => server.close(resolve))
}
