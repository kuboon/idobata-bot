# web/tests — ブラウザ smoke

opt-in のブラウザテスト。デフォルトの `deno task test`
には含まれず、`deno task test:browser` で明示的に起動する。lightpanda バイナリは
`deno run -A npm:@lightpanda/browser install` で取得する (@lightpanda/browser
1.6 以降は install 時に自動取得しない。CI も同じ手順)。

## 前提

- ルーターは起動時に `Deno.bundle` で client を bundle する
  (`web/server/assets.ts`) ので、事前のビルド手順は不要。

## 実行

```bash
deno task test:browser    # root から
```

## カバー範囲

- `browser_smoke.test.ts` — `/my` を開き、`globalThis.__rmxReady`
  が立つまで待ってから、サインインカードが「セッションを確認しています…」
  の状態を抜けることを確かめる。SSR → chunk の動的 import → island の setup
  のフル経路を exercise する。
