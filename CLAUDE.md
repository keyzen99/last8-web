# last8-web

last8.jp の静的サイト（プレーン HTML/CSS/JS・ビルドなし）。`main` への push で GitHub Pages に公開される（`.github/workflows/pages.yml`）。

| パス | 内容 |
|---|---|
| `bebeat/` `notecheck/` `pickuru/` `vocalcheck/` `privacy/` | アプリの LP とプライバシーポリシー |
| `survey/` | ライブ会場の簡単アンケート（画面＋Apps Script の受け口） |

## コマンド
```sh
node --test "survey/backend/test/*.test.js"      # アンケートのバックエンドのテスト
node survey/backend/test/dev_server.mjs 8787     # 実物の Code.gs をモックで動かすローカル確認（URL を標準出力へ）
python3 -m http.server 8000                      # それ以外のページの表示確認
```

<important if="コミット・push・ファイルの追加をするとき">
- リポジトリは PUBLIC で、リポジトリ直下がそのまま Pages に配信される。**コミットするものはすべて公開物として扱う**（`CLAUDE.md`・`.claude/` も同じ）。
- `.spec/`、`docs/COO_STATUS.md`、`.claude/agents/survey-verifier.md` は、未確認の項目や期限が読めるので作業ツリーにだけ置き、コミットしない（`.git/info/exclude` で除外している）。
- 鍵・スプレッドシート ID・個人情報・経営や法務の事情を書かない。社内の経緯は社内のリポジトリに置き、ここにはポインタだけ置く。社内リポジトリの名前に個人名が入るものは、ここに書かない。
- `git add -A` / `git add .` を使わず、パスを指定して add する（`.claude/settings.json` で拒否している）。作業ツリーに他の作業の未コミット変更が残っていることがある。
- `main` への push は本番公開なので、push の前にオーナーの承認を取る。push の前に `public-exposure-guard` を通す。
</important>

<important if="survey/ を変更するとき">
- 運営者の表示は Last8 まで。オーナーの本名を画面に出さない。送金の予告（「後で受け取れる」など）を書かない。
- 氏名・メールアドレス・位置情報を集めない。広告や解析のタグ、外部リソースを入れない。
- 金額の上限と結果の見える範囲はサーバー側（`survey/backend/Code.gs`）で守る。画面側の制御を根拠にしない。
- Apps Script は last8.dev のアカウントで動かす。他のアカウントにデプロイしない。
- 受け入れの確認は `survey-verifier` に、コードの結論を渡さず実行で確かめさせる。
</important>

## サブエージェント
| エージェント | 使う場面 |
|---|---|
| `impl-sonnet`（グローバル） | 仕様が固まった実装 |
| `survey-verifier` | `survey/` の変更後とリリース前に、完了条件を実行で確かめる |
| `public-exposure-guard` | push の前に、公開してはいけないものが差分に無いか確かめる |

## Spec 運用ルール

### 構造
```
.spec/
├── DASHBOARD.md        # 全体マップ（進捗・次アクション）
└── NNN-feature-name/
    ├── spec.md         # 仕様（目的・スコープ・成功条件）
    ├── plan.md         # 実装計画
    ├── tasks.md        # タスク（ID = NNN-T連番、絵文字 ⬜🔄✅）
    └── log.md          # 作業ログ（verify結果含む・先頭prepend）
```

### 作業ルール
1. 作業を始める前に spec ディレクトリを作る（最低 `spec.md` + `tasks.md`）。番号は default ブランチの最大 +1。
2. タスク開始時に `tasks.md` を確認、完了時に ✅ ＋ 証跡（日付・結果）をインライン記録。
3. verify 結果（build / test / 実機）は `tasks.md` か `log.md` に残す。
4. spec と実装がズレたら **コードを正** として `spec.md` を追従。
5. spec の節目・完了時に `DASHBOARD.md` を更新。
6. 同期は `/spec-status-sync`（手元→spec）/ `/spec-gh-sync`（GitHub→spec）。
7. 全タスク ✅ になった spec は `.spec/archive/NNN-feature/` へ移動し、`DASHBOARD.md` の現役一覧から外して「アーカイブ」節に1行で記録する（番号は再利用しない）。アクティブな `.spec/` 直下には進行中の spec だけを残す。

### 完了の定義
- 静的解析クリーン ＋ テスト通過（該当時）
- `tasks.md` のステータス更新済み
- `DASHBOARD.md` の進捗更新済み
- 出力物が存在し、後続タスク or 関係者が前に進める
