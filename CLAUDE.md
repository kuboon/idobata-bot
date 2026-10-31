# idobata-bot

文書への意見募集サービス。文書を読み込んだ AI と対話しながらユーザーの
意見を聞き出し、定型化して投稿する。Remix v3 + Deno で書き、Cloudflare Workers
にデプロイする。認証は id.kbn.one。

設計は 2 つ。コンセプト（何を・なぜ）は [`docs/design.md`](./docs/design.md)、
技術詳細（構成・認証・チャット・スキーマ・API）は
[`docs/architecture.md`](./docs/architecture.md)。機能を足すときは先に読み、
決めたことが変わったら直す。

[kuboon/deno-remix-tmpl](https://github.com/kuboon/deno-remix-tmpl)
から作った（server モード）。テンプレの init は済んでいて、テンプレ本体の事情
（static モード、GitHub Pages、`base`、デモ機能）はここには無い。

## 構造

- `web/` — Web アプリ
  - `web/client/` — ブラウザに渡るもの全て (routes / pages / islands / layout /
    static)。`deno.ns` 無しで型チェックされる
  - `web/server/` — router・asset bundler・API・config・og 画像
  - `web/tests/` — ブラウザ smoke テスト（opt-in）
- `/my` — id.kbn.one を IdP として使うサインイン + プッシュ通知
- `docs/design.md` — 設計（コンセプト）、`docs/architecture.md` — 技術詳細

## プッシュ通知 (id.kbn.one 連携)

id.kbn.one を Web Push のバックエンドとして使う最小構成。購読情報は IdP
が保持し、RP (このアプリ) は購読 UI と送信トリガーだけを持つ。

- ブラウザ側 (`web/client/lib/push/`, `web/client/islands/push_card.tsx`,
  `web/client/sw.js`):
  - `/sw.js` をこのオリジンに登録し push を受信 (`router.tsx`
    の専用ルートが配信。scope を `/` にするため `static/` 配下には置かない)。
  - 購読の取得/登録/改名/削除/テストは DPoP-bound fetch で IdP の
    `${IDP_ORIGIN}/push/*` を直接叩く (cross-origin)。VAPID 公開鍵も IdP
    のもの。
- サーバ側 (`web/server/lib/push/client.ts`, `lib/signing-key.ts`):
  - `POST /api/notify` がサーバ起点で通知を送る。RP は ES256 鍵で
    `private_key_jwt` クライアントアサーション ([RFC 7521]/[RFC 7523]) を作り、
    IdP の `POST /rp/notifications` へ送信する。
  - `GET /.well-known/jwks.json` で RP の公開鍵を配布し、IdP
    がアサーションを検証 する (共通鍵不要。IdP は RP の JWKS を取得するだけ)。
  - RP の `clientId` はこのアプリの origin (`RP_ORIGIN`) で、IdP の
    `AUTHORIZE_WHITELIST` に含まれている必要がある。

[RFC 7521]: https://www.rfc-editor.org/rfc/rfc7521
[RFC 7523]: https://www.rfc-editor.org/rfc/rfc7523

## 文書と段落

- 文書は Markdown で登録し、版ごとに段落（セグメント）へ分けて保存する
  （`web/server/lib/segments.ts`）。分割は `@kuboon/md` と同じ remark-parse +
  remark-gfm
  のトップレベルのノードで、段落の本文は原文をそのまま切り出したもの。
- 段落の key（`segment_key`）は版をまたいで同じ段落を指す。オーナーが編集する
  Markdown には段落の前の行に `<!-- #key -->` として見せ、保存時に読み取って
  取り除く（`withKeyMarkers` / `readKeyMarkers`）。key の無い段落には振る。
- 次の版は下書き（文書ごとに 1 つ）として `/api/docs/:docId/draft` で保存し、
  `/draft/release`
  で公開する（`lib/documents.ts`）。読者・チャット・意見の対象は
  公開済みの版だけ。
- 表示は `@kuboon/md` で文書全体を一度に描画し、トップレベルの要素を原文中の
  位置で段落に対応づける（`web/client/lib/document.ts`）。段落ごとに別々に
  描画しないのは、参照リンクや脚注を解決するため。

## 意見（3 つの部品）

設計書 §2「3 つの部品」: ①文書の保存・表示（このサイト）、②意見・賛同の投稿
（JSR `@kuboon/idobata-bot` = `packages/idobata-bot/`）、③意見の管理（API）。

- ③の API（`/api/docs/:docId/opinions`、`/api/opinions/*`、`/api/me/opinions`）
  は `web/server/lib/opinions.ts` と `controllers/api/opinions.ts`。文書は
  ID・版・ 段落キーとしか知らない。①の描画に依存させない。
- API の型と呼び出し（`createOpinionClient`）は
  `packages/idobata-bot/`。サーバー
  もその型を使う。テストもこのクライアントで通しで書く
  （`controllers/api/opinions.test.ts`）。
- ②の UI は当面このサイトの `web/client/opinions/`（`store.ts`、`panel.tsx`）。
  動いたらパッケージへ移す。
- 編集・削除は「その時点で賛同も被リンクも無く、採用されていない」ときだけ。
  判定は書き込みの `WHERE` にも入れて、競合しても破られないようにする。

## チャット（Workers AI）

`docs/architecture.md`
§5。[`@remix-kbn/helper-agent`](https://jsr.io/@remix-kbn/helper-agent)
の上に作る。`POST /api/docs/:docId/chat?v=<版>` が 1 ターンを helper-agent
の形式（SSE）で返す（`controllers/api/chat.ts` が `helperAgentController` に
`lib/chat/mod.ts` の `chatAgent` を渡す）。ログイン 不要。

- 画面: 意見のある段落は下線。右下の「AI と対話」ボタンは常に出ていて、選択が
  無くても話せる（`opinions/assistant.ts`。ページに 1 つの会話）。段落を
  タップすると、意見パネル（`opinions/panel.tsx`）がその段落の上にフロートで
  出る（本文を動かさない。上に余地が無ければ下。× で閉じる）。パネルの 「AI
  と対話する」も同じ会話を開く。
- オーナーには文書の見出しの下に「管理」トグルが出る（既定はオフ、`localStorage`）。
  オンにすると store が `/manage` を読み、非表示の意見とモデレーションの記録を
  出し、非表示・再表示ができる。トグルは表示だけで、API は毎回オーナーかを
  確かめる。管理画面には意見の一覧は無い。
- 意見は必ず AI との対話で書く。手で書くボタンや「この意見に応答」は無く、
  投稿ダイアログを開くのは AI の `draft_opinion` だけ（賛同はパネルからも可）。
- 選択は会話に固定しない。AI はブラウザのツール `get_selection` で読者の選択を
  読み、`select_segments` で段落を選んで見せる（「それはこの部分ですね」）。
- 履歴はブラウザの helper-agent のセッションだけ（メモリ。タブを閉じる・
  サインインで遷移すると消える）。assistant の `state` にモデルのメッセージ
  （本文と tool call）を入れて往復させ、サーバーは検査して再生する
  （`assistantFrom`）。サーバーは何も保存しない。
- `messages[0]`（system: 指示文と番号付きの文書）はサーバーが毎回同じバイト列で
  作る（`lib/chat/prompt.ts` の `systemMessage`）。版は URL の query
  で固定する。 選択や意見の一覧など、変わるものを入れない（prefix
  キャッシュが外れる）。
- モデルは Workers AI の `@cf/qwen/qwen3.8-27b`（`lib/chat/model.ts`）。Clef と
  同じ `env.AI`（`lib/chat/ai.ts` の `useAi`）で呼び、API キーは要らない。
  binding が無いと `503`。メッセージとツールは chat-completions の形。
- 前段フィルタは Workers AI の Clef（`lib/chat/filter.ts`、`worker.ts` の
  `useAi(env.AI)`）。binding が無い（ローカル・テスト）と素通し。弾いた件数だけ
  `filter_stats` に数え、定型文を返す。
- ツール: `search_opinions` / `get_opinion` はサーバーで回す
  （`lib/chat/tools.ts`）。段落はモデルにはブロック番号で見せる。
  `get_selection` / `select_segments` はブラウザのツール（そのまま渡す）。
  `draft_opinion` もブラウザのツール: サーバーが `resolveDraft` で検査して
  段落キーに直した `ChatDraft` を tool-call で渡し、ブラウザが下書き入りの投稿
  ダイアログ（`opinions/post_dialog.tsx`、`opinions/compose.ts`）を開いて、
  投稿した／閉じたを結果として返す。投稿はユーザーがする。
- tool の model への定義は常にサーバーの `TOOLS`（ブラウザが送る schema は
  使わない。キャッシュの prefix を変えないため）。
- `@kuboon/chat-element` 0.1.0 は、テキスト無しで始まる 2 ラウンド目を前の
  ラウンドの tool 結果より前に並べてしまうので、ラウンドの頭で空の `text`
  を送っている（`chatAgent`）。
- AI の返答は Markdown。chat-element の `renderReply` に
  `opinions/chat_markdown.ts` の `renderMarkdownReply`（`@kuboon/md`）を渡して
  描く（greeting も通る）。
- モデルを呼ぶのは `lib/chat/model.ts` だけ。テストは `ChatModel` を台本で
  差し替え、helper-agent の `HelperAgentSession` で通す
  （`controllers/api/chat.test.ts`）。
- URL と `ChatDraft` の型は `packages/idobata-bot/chat.ts`。

## 認証 (API)

RP 側にセッションは持たない（`docs/architecture.md`
§2）。`web/server/middleware/auth.ts`:

- `dpopClient()` — 全 API に付ける。`DPoP` proof を検証し、鍵の thumbprint を
  `context.get(Client)` に置く。
- `requireUser()` — ログイン必須の API に、`dpopClient()` の後に付ける。
  `Authorization: DPoP <jws>`（IdP の `/session` が返す token）を IdP の JWKS で
  検証し、`cnf.jkt` が proof の鍵と一致することを確かめて `context.get(User)` に
  置く。初回は `users` を作る（nickname の初期値は IdP の値）。
- ブラウザは `sessionStore.apiFetch(path, init)`（`web/client/session.ts`）で
  呼ぶ。proof と token を付け、401 なら `/session` を取り直して 1
  回だけ再送する。
- テストは `@kuboon/dpop` の
  `init({ keyStore: new InMemoryKeyRepository(), fetch })` で proof
  を作り、`jose` のローカル鍵で IdP の token を作る
  （`web/server/controllers/api/me.test.ts`）。

## データベース (D1)

D1 を `@remix-run/data-table` + `@remix-kbn/data-table-d1` で使う。

- スキーマは `db/migrations/<YYYYMMDDHHmmss>_<name>/up.sql`（と `down.sql`）。
  `web/server/db/schema.ts` の `table()` 定義と列を揃える（`schema.test.ts` が
  全テーブルを往復させて確かめる）。
- `web/server/db/mod.ts` の `getDb()` が DB を返す。入口ごとに `useDatabase()`
  で 設定する: Worker は初回リクエストで `env.DB`、`router.tsx` は
  `web/server/db/local.ts` の `openLocalDatabase()`（`LOCAL_DB` のファイル、
  未設定ならメモリ。開くたびにマイグレーションを当てる）。`db/local.ts` は
  `node:sqlite` を使うので `worker.ts` から import しない。
- D1 には対話的トランザクションが無い。`db.transaction()` は書き込みを溜めて
  `batch()` 1 回で送るので、中では書き込みの戻り値を使わない・書き込みの後に
  読まない・入れ子にしない。
- D1 は 1 文に bind できるパラメータが 100 個まで（ローカルの SQLite は数千）。
  `createMany` は 行数×列数、`inList` は値の数だけ使うので、行や値が増えうる所は
  `chunksForD1()`（`db/mod.ts`）で分ける。`db/local.ts` のローカル DB も 100 を
  超える文を拒むので、テストと `deno task dev` で本番と同じく落ちる。
- `deno task db migrate`（ローカルの `data/app.db`）、
  `deno task db migrate --remote`（本番。`CLOUDFLARE_D1_DATABASE_ID` と D1 編集
  権限のある `CLOUDFLARE_API_TOKEN` が要る）。

## 環境変数

env アクセスは `web/server/config.ts` に集約し、ホスト非依存にしてある。
`loadConfig(env)` が env レコードから型付き `Config` を作り、`getConfig()` が
ホストに応じて env を自前で取得する (配線不要): Deno は `Deno.env`、Cloudflare
Workers は `cloudflare:workers` の `env`。後者は動的 `import()` なので、その
モジュールを持たない Deno はロードで落ちずフォールバックできる (静的 import は
Deno で catch 不能なエラーになる)。env は top-level await
で起動時に一度だけ解決・保持するので `getConfig()` は sync。

- `IDP_ORIGIN` — 外部 IdP の origin (例: `http://localhost:8000`)。`/my`
  ページが `${IDP_ORIGIN}/authorize` へ DPoP thumbprint と redirect_uri
  を付けて遷移し、戻った後 `${IDP_ORIGIN}/session` で userId を取得する。
- `RP_ORIGIN` — このアプリの公開 origin。`POST /api/notify` のクライアント
  アサーションの `clientId`/`iss`/`sub` に使う。IdP の `AUTHORIZE_WHITELIST`
  に登録が必要。未設定だと送信時にエラーになる。
- `RP_SIGNING_KEY_JWK` — 任意。ES256 秘密鍵 (JWK JSON)。未設定ならプロセス毎に
  生成
  (開発用)。本番では固定鍵を設定し、再起動で鍵がローテートしないようにする。
  本番の鍵は手動の workflow `.github/workflows/rp-signing-key.yml` が CI 上で
  生成して Worker secret に置く（GitHub には残らない）。既にあれば上書きしない
  （`overwrite` を付けて実行すると作り直す）。
- `LOCAL_DB` — ローカル専用。`router.tsx` が開く SQLite ファイル
  （`deno task dev` は `data/app.db`）。未設定ならメモリ。
- `SITE_URL` — 静的ビルド専用。公開 origin を渡すと、social card の `og:image`
  を絶対 URL にする（Cloudflare 側のビルドの環境変数に設定）。未設定なら
  相対パス。

## デプロイ (Cloudflare Workers)

`web/server/router.tsx` が唯一のルーター定義で、素の `@remix-run/fetch-router`
の router を default export する。ローカル (`deno serve`) とテストはこれを
そのまま使う。

デプロイは Cloudflare 側のビルド（Workers Builds、GitHub 連携。設定はダッシュ
ボード）が行い、main への push で本番、ブランチで preview を出す。ビルドは
`deno task build:cf` で、**静的ビルド (`web/dist`) を Workers の static assets**
として、 **server 専用ルート (`/api/*`, `/.well-known/jwks.json`) だけを Worker
(`web/server/worker.ts`)** で配信する。

- 静的ビルドは `deno task build`（`@remix-kbn/ssg`）。同じ router を `fetch()`
  でクロールして `web/dist` に静的 HTML を書き出す。クロールは `entryPoints`
  (`/`、`/my`、og 画像、`/sw.js`) とそこからのリンクだけを辿る。どこからも
  リンクしていない `/api/*` は静的化されない。
- 文書ページ `/d/:docId` は文書ごとに静的化できないので、ビルドは `/d/_shell` を
  1 枚だけ書き、Worker が `/d/*` をその殻で返す（`env.ASSETS` から取り、
  `HTMLRewriter` で `<title>` / OGP を文書のものに書き換える。
  `web/server/document_shell.ts`）。文書の中身は island が API から取る。
- `router.tsx` は `Deno.bundle` / `Deno.readTextFile` を使うので Workers では
  動かさない。**API を足したら `worker.ts` にも配線する**（`router.tsx` だけに
  足すと Cloudflare に出ない）。
- `cloudflare.config.ts` が `cf` CLI の設定 (`assets.runWorkerFirst` で Worker
  に回すパスを指定)。秘密（`RP_SIGNING_KEY_JWK` 等）は設定に書かず Worker の
  secret に置く。`bindings.secret()`
  で宣言もしない（宣言すると必須になり、Worker
  がまだ無い初回デプロイが通らない。宣言しなくてもデプロイは secret を残す）。
- `cf build` は Wrangler か Vite プラグインを呼ぶだけで `jsr:` を解決できない
  ので使わない。`deno bundle` で作った Worker (`web/worker-dist/worker.js`) と
  `web/dist` を `web/server/cf_build.ts` が Build Output Specification
  (`.cloudflare/output/v0`) に並べ、`cf deploy --prebuilt` でアップロードする
  (`deno task cf ...` が `npm:cf` の実行)。
- 本番のデプロイコマンドは `deno task deploy`（`deploy.sh`）。Worker の設定が
  最後に Cloudflare 側で変わっていると（ダッシュボードで secret を設定した等）、
  `cf deploy` は上書きの確認を出し、ビルドの中ではそこで止まる。`deploy.sh` は
  疑似端末で Yes と答える（`cloudflare.config.ts` が正。上書きする差分はログに
  出る）。
- preview（main 以外のブランチ）のデプロイコマンドは
  `deno task deploy:preview`。 ビルドコマンドは本番と共通なので、preview 用に
  `build:cf --preview` で Build Output を書き直してから
  `cf previews deploy --prebuilt`（preview 名は ブランチ名）。
- preview は別の D1 `idobata-bot-preview` を使う（`cloudflare.config.ts` の
  `ctx.isPreview`。本番 `idobata-bot` とも名前と ID
  の両方で指定してある。`deno task build:cf --preview` が preview 用の Build
  Output を 書く）。マイグレーションは両方に当てる。preview の origin は IdP の
  whitelist に無いので、サインインは動かない。
- 両 router（`router.tsx` と `worker.ts`）に `@remix-run/cop-middleware` の
  `cop()` を入れてある。`Sec-Fetch-Site` / `Origin` で、クロスオリジンの
  ブラウザからの unsafe メソッド（`POST /api/notify` など）を token 無しで
  拒否する。別オリジンから API を叩く構成にするなら `trustedOrigins` を足す。

## 開発

```bash
deno task dev      # web アプリの開発サーバー起動
deno task build    # 静的サイトを web/dist へ生成
deno task build:cf # 静的サイト + Worker を .cloudflare/output へ (cf deploy --prebuilt 用)
deno task test     # サーバーのテスト実行
deno task test:browser  # ブラウザ smoke テスト (lightpanda)
deno task check    # 型チェック + lint + fmt
```

変更前後に `deno task check && deno task test && deno task build:cf` と
`deno task test:browser` を通す。

- 追加した `import` は `deno.json`（ルート）にだけ書く。メンバー側の `deno.json`
  には書かない。
- コンポーネントランタイムは `@remix-run/component`（`ui` ではない）。

## コーディング規約

- Deno ファースト（Web API 優先、Node.js API は必要最小限）
- TypeScript strict mode
- テストは `Deno.test()` + `@std/assert`
- ファイル名はスネークケース（例: `dpop_test.ts`）
- ページ/island の見た目は `@remix-run/component` の `css()` mixin と
  `web/client/tokens.ts` のトークンで書く (Tailwind / daisyUI は使わない)
- ブラウザへ渡るコードは `web/client/` に置き、`Deno.` を参照しない
