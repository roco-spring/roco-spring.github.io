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
