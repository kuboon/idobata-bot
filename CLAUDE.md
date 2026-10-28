# idobata-bot

文書への意見募集サービス。文書を読み込んだ AI（Claude）と対話しながらユーザーの
意見を聞き出し、定型化して投稿する。Remix v3 + Deno で書き、Cloudflare Workers
にデプロイする。認証は id.kbn.one。

設計は [`docs/design.md`](./docs/design.md)。機能を足すときは先にそこを読み、
決めたことが変わったら設計書も直す。

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
- `docs/design.md` — 設計書

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
- `SITE_URL` — 静的ビルド専用。公開 origin を渡すと、social card の `og:image`
  を絶対 URL にする（`.github/workflows/cloudflare.yml` が設定）。未設定なら
  相対パス。

## デプロイ (Cloudflare Workers)

`web/server/router.tsx` が唯一のルーター定義で、素の `@remix-run/fetch-router`
の router を default export する。ローカル (`deno serve`) とテストはこれを
そのまま使う。

`.github/workflows/cloudflare.yml` が main への push で `deno task build:cf` を
走らせ、**静的ビルド (`web/dist`) を Workers の static assets** として、
**server 専用ルート (`/api/*`, `/.well-known/jwks.json`) だけを Worker
(`web/server/worker.ts`)** で配信する。

- 静的ビルドは `deno task build`（`@remix-kbn/ssg`）。同じ router を `fetch()`
  でクロールして `web/dist` に静的 HTML を書き出す。クロールは `entryPoints`
  (`/`、`/my`、og 画像、`/sw.js`) とそこからのリンクだけを辿る。どこからも
  リンクしていない `/api/*` は静的化されない。
- `router.tsx` は `Deno.bundle` / `Deno.readTextFile` を使うので Workers では
  動かさない。**API を足したら `worker.ts` にも配線する**（`router.tsx` だけに
  足すと Cloudflare に出ない）。
- `cloudflare.config.ts` が `cf` CLI の設定 (`assets.runWorkerFirst` で Worker
  に回すパスを指定)。秘密（`RP_SIGNING_KEY_JWK` 等）は設定に書かず Worker の
  secret に置く。
- `cf build` は Wrangler か Vite プラグインを呼ぶだけで `jsr:` を解決できない
  ので使わない。`deno bundle` で作った Worker (`web/worker-dist/worker.js`) と
  `web/dist` を `web/server/cf_build.ts` が Build Output Specification
  (`.cloudflare/output/v0`) に並べ、`cf deploy --prebuilt` でアップロードする
  (`deno task cf ...` が `npm:cf` の実行)。
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
