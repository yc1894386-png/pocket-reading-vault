# Vellum Cloudflare R2 快速同步后端

这个版本是速度版：

- KV 保存很小的索引、阅读进度、排序、文件夹。
- R2 按单篇文章保存正文、summary、tag、高亮。
- 图片默认只保存链接，不自动把图片原图塞进 R2。
- 阅读时只上传进度小包，不再因为翻页就整库上传。

## Cloudflare 网页部署步骤

1. 打开 Cloudflare Dashboard，进入 `Workers & Pages`。
2. 新建 Worker，名字可以叫 `vellum-sync`。
3. 把 `worker.js` 里的代码全部复制进去，保存并部署。
4. 创建一个 KV namespace，名字可以叫 `VELLUM_SYNC`。
5. 创建一个 R2 bucket，名字建议叫 `vellum-library`。
6. 回到 Worker 的 `Settings` -> `Bindings`，添加两个绑定：

```text
类型：KV namespace
Variable name：VELLUM_SYNC
KV namespace：选择刚建的 VELLUM_SYNC

类型：R2 bucket
Variable name：VELLUM_BUCKET
R2 bucket：选择 vellum-library
```

7. 保存后重新部署 Worker。
8. 打开 Worker 地址，看到类似下面这样就是成功：

```json
{
  "ok": true,
  "service": "vellum-sync",
  "storage": "cloudflare-kv-progress+r2-works",
  "r2": true,
  "imageMode": "links-by-default",
  "protocol": "v2-sharded"
}
```

9. 把 Worker 地址填进 Vellum 的“Cloudflare Worker 地址”，例如：

```text
https://vellum-sync.your-name.workers.dev
```

然后手机和电脑填同一个同步码即可。

## 用量控制

这版不会默认备份图片原图，所以几百篇文字作品通常远低于 10GB。真正吃空间的是图片文件；Vellum 现在只同步图片链接，本机浏览器仍会照常缓存已经看过的图片。
