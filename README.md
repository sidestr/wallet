# sidestr wallet

A wallet for a sidestr chain that needs nothing of the chain's producer: it reads and validates
the chain from a **mirror** (the same `chain.json`, `blocks.json`, `blocks.dat` the explorer
uses), keeps your key in the browser, signs spends in the page, and sends them to a **Nostr
relay** as kind 23500 events, where the producer picks them up. SPEC section 11.

Open `index.html?chain=<chain id>` (the wallet asks the relays for the signer's tip announcement, which names the mirrors, and takes the one whose `chain.json` names the announcer as signer) or `index.html?mirror=<mirror URL>`. It follows the announcements live, so a new block shows within seconds, and it marks the mirror ✓ or ⚠ against the signer's announced tip. The engine and libraries load from pinned commits on
jsdelivr; `?lib=`, `?cdn=` and `?explorer=` override them for development.

`wallet.mjs` is the logic with no DOM, so `node test/wallet-test.mjs --mirror <URL>` (or `--chain <id>`) exercises
it against a live chain: identity, coins and maturity, a real signed spend checked with the
curve's verifier, codec round-trip, address handling; `--send` publishes it and waits for the
mirror. Keys are stored unencrypted in the browser, as the BLAKE wallet does: small amounts.
