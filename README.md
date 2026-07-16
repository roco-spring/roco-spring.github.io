# RoCo-Spring

Website for **RoCo-Spring**, the Robust Correspondence Challenge at NeurIPS 2026.

## About the challenge

RoCo-Spring evaluates how well dense correspondence methods hold up under realistic distribution shifts. Participants submit methods for:

- **Optical flow**
- **Stereo matching**
- **Scene flow**

The challenge measures both clean accuracy and robustness to corruptions such as noise, adverse weather, blur, compression, and illumination changes. It is built on the Spring and RobustSpring datasets.

## Run locally

This is a static site. Some pages load shared layout via `fetch`, so open it through a local web server.

From the repository root (`roco-spring.github.io`):

```bash
python -m http.server 8080
```

Then visit [http://localhost:8080](http://localhost:8080).

## Team registration

The registration page remains part of the vanilla static site. It uses Firebase Authentication, App Check, private callable Cloud Functions, and a deny-by-default Firestore data layer. The backend creates one private organizer Sheet per team and delivers first-login credentials through Gmail API; the browser never receives Google credentials or direct access to team records.

See [SETUP_TEAM_REGISTRATION.md](SETUP_TEAM_REGISTRATION.md) for architecture, local emulator setup, the secure one-time OAuth procedure, deployment, and recovery instructions.

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

Passwords, OAuth secrets and refresh tokens, service-account credentials, App Check debug tokens, and the rate-limit HMAC secret are never stored in this public repository.
