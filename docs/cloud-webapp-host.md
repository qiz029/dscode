# Cloud web app host: design and trust model

An architecture design for the shape where a user reaches their own DSCODE from a browser anywhere. Execution, files and keys always stay on the user's own machine; the Hub (dshpluginhub.ai) cannot read user content **by architecture**.

Status: design baseline, not implemented. P0 validation has not started.

## 1. Goals and constraints

**Goal**: a user reaches their own DSCODE host from a browser on any device and any network, with an experience aligned to the `dsh-web-app` web surface already in place (chat, models and settings, session history, approvals).

**Constraints (settled)**:

1. **Mandatory end-to-end encryption**: the Hub never touches plaintext, including session content, file content and credentials.
2. **Multi-tenant**: each user has an independent host; one user's credentials cannot reach another user's host.
3. **The web surface does not replicate terminal-only capability**: the compaction Tetris indicator, keyboard interaction panels and the like do not enter the web.
4. **No dependency on Tailscale or any third-party tunnel**: the tunnel and relay are built on the Hub side (cloudflared may be used only for P0 validation).
5. **Local execution**: the agent's shell, filesystem, keys and approvals all complete on the local host, and the Hub cannot loosen local policy.

## 2. Architecture

```
[browser · anywhere]
     │  HTTPS (Hub login state / passkey)
     ▼
[dshpluginhub.ai]          ← identity · host directory · blind relay · connection-level audit · quotas
     ▲  outbound WSS long connection (the local machine dials out; no inbound port is opened)
     │
[user machine · dscode host]    ← the only place execution happens
     └ dsh --profile web (binds 127.0.0.1 only) + DSCODE service-layer plugins
```

**Data flow**:

1. The user logs in to the Hub and completes device binding with a passkey (see section 5).
2. The local `dscode host up` dials the outbound WSS tunnel with a short-lived host credential and registers its `host-id` and public key with the Hub.
3. The browser opens `dshpluginhub.ai/h/<host-id>`: the Hub authenticates the user → looks up the directory → establishes a relay to that host.
4. The browser and that host negotiate an E2E session key; from then on every API call and event travels inside that channel.
5. Sensitive operations (writing files, running commands, installing dependencies) are still decided by the local DSCODE approval / auto-review, and ask the user for confirmation over the E2E channel in the web UI.

**Trust boundary**: the Hub takes part in identity and routing only in steps 2–3; after step 4 what it forwards is ciphertext.

## 3. Key decision record

| Decision | Choice | Consequence |
|---|---|---|
| Encryption | **Mandatory E2E** | The Hub cannot offer content indexing/search, AI content moderation or cross-tenant content sharing. In exchange it is "architecturally unable to see" |
| Tenancy | **Multi-tenant** | Isolation lands in the authorisation and routing layer (execution is naturally separate). It needs quotas, abuse protection, a per-tenant host directory and auditing |
| Web capability | **No terminal replication** | The web keeps only the service-layer plugins; TUI-only components (tui-tools, Tetris, keyboard panels) do not migrate |
| Tunnel | **Self-built outbound tunnel** | No third-party visibility is introduced; it stays one piece with Hub auth/audit/quota |
| Keys/identity | **passkey (WebAuthn PRF)** | A new device needs no pairing; it depends on browser PRF support and raises the SPA trustworthiness requirement (section 6) |

## 4. Trust design

| Mechanism | Description |
|---|---|
| **Outbound only** | The host only dials out; it listens on no public port. `dscode host down` disconnects immediately — "there is no channel into your computer" is structural |
| **Hub blind relay** | It forwards authenticated frames only and parses no content. Sessions, credentials, review and cost records stay on the local machine (as today, under `~/.local/share/dscode-hub`) |
| **E2E data plane** | The browser and the host negotiate a session key, and the Hub only has the public key |
| **Authorization on the host side** | The host verifies the **short-lived** token the Hub issued (bound to host-id, audience and expiry) and does not take "the Hub says this is who they are" at face value |
| **Minimal exposure** | The tunnel forwards only whitelisted paths (the web UI + `dsh-api-gateway`), with no filesystem or shell passthrough |
| **Local policy cannot be bypassed** | Approval, auto-review and the platform sandbox all execute locally; the Hub cannot loosen them |
| **Auditable and revocable** | `dscode host status` lists online devices, origin and token expiry; `dscode host revoke <device>` disconnects and rotates |
| **Privacy engineering keeps the existing standard** | `dsh-hub` telemetry already keeps events free of account, machine ID, IP fields, paths, configuration and keys, and supports a `DSH_HUB_TELEMETRY_DEBUG=1` preview. The tunnel and host components keep the same standard and are open source |

## 5. E2E key model (passkey)

**The trust root is the local host, not the Hub and not the passkey.** A passkey is only a convenient credential with which a new device retrieves the host key.

1. **Host key pair**: enabling remote access generates `(sk_host, pk_host)` locally; `pk_host` and `host-id` register with the Hub.
2. **Passkey binding**: the browser derives `K_wrap` through HKDF from the WebAuthn PRF output. The PRF output is computed only in the browser and is not part of the assertion, so the Hub cannot obtain it.
3. **Wrapping**: after the user completes one binding in the browser, `sk_host` is wrapped with `K_wrap` and uploaded to the Hub (ciphertext only). The Hub stores `pk_host` and the ciphertext.
4. **New device**: a new browser → passkey verification → derive `K_wrap` → fetch the ciphertext from the Hub → unwrap to `sk_host` → establish E2E with the host.
5. **Recovery**: when the passkey is lost, local access to the host (terminal or LAN) is enough to re-wrap and bind a new passkey. **The local host is always the recovery anchor**.
6. **Revocation**: `dscode host revoke` rotates `sk_host`, invalidating every published ciphertext.

**To verify**: the browser/platform support matrix for the WebAuthn PRF extension; the fallback when it is unsupported is device pairing (confirming a new device on one already-authorised device), a path that introduces no Hub visibility.

## 6. SPA verifiability (the precondition for E2E)

The PRF output is obtained by **page script**, so "the SPA is trustworthy" is a precondition for E2E: a server that poisons the front end can steal the keys.

Requirements:

1. The web front end is **open source** and reproducibly built;
2. Every release publishes its build hash, the browser verifies it after loading (SRI + a runtime self-check), and a failed verification refuses to establish the E2E channel;
3. The verification logic runs as early as possible, before any key operation.

"Serve the SPA from the host through the tunnel" is not adopted as the primary approach: the first paint still goes through the Hub, so the gain is limited while the complexity grows.

## 7. Tenancy and authorisation model

- **A separate host per user**: execution separation is natural, and the Hub needs no shared execution sandbox.
- **Host directory**: a `host-id` belongs to one user, and only that user (and sessions they explicitly authorise) can connect.
- **Credential chain**: Hub login → short-lived host token (signed, bound to host-id/audience/expiry) → host verification → E2E established.
- **Quotas and abuse protection**: limited by connection count, bandwidth and concurrency on the Hub side (content cannot be metered under E2E).
- **Audit**: metadata such as connection time, origin, duration and disconnect reason; no content.

## 8. Reuse and new work

**Already reusable**:

- Hub identity and profile lifecycle, where `--profile web` is already a first-class parameter of the `dsh-hub` commands (`install` / `profile apply|share|upgrade|diff|doctor|rollback`);
- The local web trio: `dsh-host-webserver` (the HTTP/SPA seat), `dsh-web-app` (the browser GUI), `dsh-api-gateway` (two-ended RPC) plus `dsh-api-*-controller`;
- The local RPC pattern of `plugins/session-bridge`: Unix socket + auth + request/receipt;
- The Hub's existing privacy and telemetry engineering practice.

**New work**:

- Hub-side host registry and relay service, and the outbound tunnel protocol;
- Host-side `dscode host up/down/status/revoke` and the tunnel client;
- The passkey bind/wrap/unwrap flow and the recovery path;
- Presenting approvals and human interaction in the web UI;
- **DSCODE's web profile**: getting the service-layer plugins to run under the `dsh-web-app` host while skipping the terminal-only parts.

## 9. Roadmap

**P0 · compatibility survey (local, zero external dependency)**
Start a local web host with `--profile web`, mount DSCODE's own plugins one by one, record what works and what errors out, and produce a "what the web profile must change" list plus a minimal working web-profile sketch. No remote access is unlocked.

**P1 · a usable path end to end**
Hub-side host directory and relay, the host-side tunnel client, Hub login + short-lived token authorization, the device list and revocation, and web approval interaction. This stage may **skip E2E first** (validating the path in a controlled environment only) but must assume the Hub can see.

**P2 · a trust level worth promising**
E2E (passkey + wrap/unwrap), verifiable SPA builds and hash checking, an audit panel, a privacy statement and open source, quotas and abuse protection.

## 10. Threat model

**Defended**: the Hub operator reading content (E2E), unauthorised access, credential replay, man-in-the-middle, cross-tenant access, front-end poisoning (relying on the section 6 measures).

**Not defended**: the user's own machine already compromised, a controlled browser or extension, the user handing the access link to someone else, denial of service against the Hub.

## 11. Open questions

1. The browser/platform support matrix for WebAuthn PRF, and the design details of the degraded experience;
2. The implementation choice for the relay service (a self-built WSS forwarder vs adopting a mature tunnel core) and a self-hosting plan;
3. How the Hub meters under E2E (connection/bandwidth) and its quota policy;
4. The approval experience in the web UI (timeout, offline, batch authorisation);
5. Which DSCODE service-layer plugins depend on macOS (sandbox, keychain, computer-use) and what replaces them on a non-macOS host.
