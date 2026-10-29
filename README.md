# idobata-bot

文書への意見募集サービス。文書を読み込んだ AI と対話しながら意見を聞き出し、
定型化して投稿する。似た意見がすでにあれば対話の中で示し、賛同したり、その意見
への疑問・補足として書いたりできる。

- 本番: <https://idobata-bot.kuboon.workers.dev/>
- 設計:
  [docs/design.md](./docs/design.md)（コンセプト）、[docs/architecture.md](./docs/architecture.md)（技術詳細）
- 開発のルール: [CLAUDE.md](./CLAUDE.md)

Remix v3 + Deno で書き、Cloudflare Workers にデプロイする。
[kuboon/deno-remix-tmpl](https://github.com/kuboon/deno-remix-tmpl) から作った。
