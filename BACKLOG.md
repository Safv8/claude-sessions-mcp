# Backlog — claude-sessions-mcp
Open items only; closed work goes out of this file.

- **spawn_session sessions sit idle** (vault INBOX 13-10): `mcp__sessions__spawn_session` started 5 sessions (feedsync, marketplace-management, wheelerworks-ops, pelamigo x2) that got their prompt and a handful of empty system events, then sat idle with no assistant turn for 40+ min; archived, work rerun as agents from the vault. Reproduce, find why no turn starts (prompt delivery vs Remote Control bridge), add a spawn check that fails loud when no assistant turn arrives. Belongs with the vault's "Sessie remote control betrouwbaarheid" work.
