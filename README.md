# RoCo-Spring

Website for **RoCo-Spring**, the Robust Correspondence Challenge at NeurIPS 2026.

## About the challenge

RoCo-Spring evaluates how well dense correspondence methods hold up under realistic distribution shifts. Participants submit methods for:

- **Optical flow**
- **Stereo matching**
- **Scene flow**

The challenge measures both clean accuracy and robustness to corruptions such as noise, adverse weather, blur, compression, and illumination changes. It is built on the Spring and RobustSpring datasets.

## Production architecture

Production is entirely remote and remains available when every development machine and cluster node is powered off:

- GitHub Pages serves the public HTML, CSS, JavaScript, and assets.
- Firebase Authentication, App Check, Firestore, and Cloud Functions run the registration application in Google Cloud.
- Google Cloud Scheduler invokes the Firebase reconciler every five minutes; Cloud Monitoring sends incident alerts through a verified remote notification channel.
- Google Drive, Sheets, and Gmail hold the private organizer records and send registration messages.

No production service depends on an organizer workstation, this repository checkout, a localhost server, an emulator, a shell session, or a cluster process. Local servers and Firebase emulators are development/test tools only. The OAuth bootstrap and deployment commands are one-time administrative operations that update managed cloud resources and may exit immediately after they finish.

## Run locally

This is a static site. Some pages load shared layout via `fetch`, so open it through a local web server.

From the repository root (`roco-spring.github.io`):

```bash
python -m http.server 8080
```

Then visit [http://localhost:8080](http://localhost:8080).

## Team registration

The registration page remains part of the vanilla static site. Its four callable Cloud Run transports are public so browsers can reach them, while Firebase App Check and Auth guards enforce application access and Firestore denies all direct browser reads/writes. The private scheduled reconciler is OIDC-invoked by Cloud Scheduler, is never granted public invocation, and is the only runtime that binds OAuth. It creates one private organizer Sheet per team and delivers first-login credentials through Gmail API; the browser never receives Google credentials or direct access to team records.

See [SETUP_TEAM_REGISTRATION.md](SETUP_TEAM_REGISTRATION.md) for the remote architecture, local-only emulator setup, secure one-time OAuth procedure, deployment, monitoring verification, and recovery instructions.

Install dependencies and run the checks from the repository root:

```bash
npm ci
npm --prefix functions ci
npm test
npm run build
npm run lint
npm run security:scan
```

After the documented OAuth preflight and Secret Manager setup, deploy the backend with:

```bash
npm run deploy:production
```

The release chain idempotently configures four remote Cloud Monitoring alerts only after it finds the enabled, verified organizer email channel, then verifies the exact Function inventory, Cloud Run IAM boundary, five-minute Scheduler target/recent success, and alert definitions. These are one-time operator commands; after they exit, GitHub Pages, Firebase, and Google Cloud continue running without this node.

Passwords, OAuth secrets and refresh tokens, service-account credentials, App Check debug tokens, and the rate-limit HMAC secret are never stored in this public repository.
