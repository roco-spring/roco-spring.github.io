const canvas = document.getElementById("flow-canvas");
const ctx = canvas.getContext("2d");

const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
).matches;

let width;
let height;
let dpr;
let particles = [];
let time = 0;

const mouse = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    px: window.innerWidth / 2,
    py: window.innerHeight / 2,
    vx: 0,
    vy: 0,
    active: false
};

const config = {
    particleCount: 850,
    particleSpeed: 1.55,
    particleLife: 220,
    vectorSpacing: 42,
    cursorRadius: 190,
    cursorStrength: 3.8
};

function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const area = width * height;
    config.particleCount = Math.min(1200, Math.max(360, Math.floor(area / 1800)));

    particles = Array.from({ length: config.particleCount }, createParticle);
}

function createParticle() {
    return {
        x: Math.random() * width,
        y: Math.random() * height,
        px: 0,
        py: 0,
        life: Math.random() * config.particleLife
    };
}

function flowAt(x, y) {
    const nx = x * 0.0042;
    const ny = y * 0.0042;

    const angle =
        Math.sin(nx + time * 0.007) * 1.4 +
        Math.cos(ny - time * 0.006) * 1.2 +
        Math.sin((nx + ny) * 0.72) * 1.7;

    let vx = Math.cos(angle);
    let vy = Math.sin(angle);

    const dx = x - mouse.x;
    const dy = y - mouse.y;
    const dist = Math.hypot(dx, dy);

    if (mouse.active && dist < config.cursorRadius) {
        const influence = (1 - dist / config.cursorRadius) ** 2;
        const swirlX = -dy / Math.max(dist, 1);
        const swirlY = dx / Math.max(dist, 1);

        vx += swirlX * influence * config.cursorStrength;
        vy += swirlY * influence * config.cursorStrength;

        vx += mouse.vx * 0.018 * influence;
        vy += mouse.vy * 0.018 * influence;
    }

    return { vx, vy };
}

function drawVectorField() {
    ctx.save();
    ctx.lineWidth = 1;

    for (let y = 24; y < height; y += config.vectorSpacing) {
        for (let x = 24; x < width; x += config.vectorSpacing) {
            const flow = flowAt(x, y);
            const mag = Math.hypot(flow.vx, flow.vy);
            const len = 13 + Math.min(mag, 4) * 4;

            const ax = flow.vx / mag;
            const ay = flow.vy / mag;

            const cursorDistance = Math.hypot(x - mouse.x, y - mouse.y);
            const alpha = mouse.active
                ? 0.13 + 0.11 * Math.max(0, 1 - cursorDistance / 360)
                : 0.13;

            ctx.beginPath();
            ctx.moveTo(x - ax * len * 0.35, y - ay * len * 0.35);
            ctx.lineTo(x + ax * len * 0.65, y + ay * len * 0.65);
            ctx.strokeStyle = `rgba(142, 226, 255, ${alpha})`;
            ctx.stroke();
        }
    }

    ctx.restore();
}

function drawParticles() {
    ctx.save();
    ctx.lineWidth = 1.15;

    for (const particle of particles) {
        particle.px = particle.x;
        particle.py = particle.y;

        const flow = flowAt(particle.x, particle.y);
        const mag = Math.hypot(flow.vx, flow.vy);

        particle.x +=
            (flow.vx / mag) * config.particleSpeed * Math.min(mag, 3.8);
        particle.y +=
            (flow.vy / mag) * config.particleSpeed * Math.min(mag, 3.8);

        particle.life -= 1;

        if (
            particle.x < -20 ||
            particle.x > width + 20 ||
            particle.y < -20 ||
            particle.y > height + 20 ||
            particle.life <= 0
        ) {
            Object.assign(particle, createParticle());
            particle.life = config.particleLife;
            continue;
        }

        const localCursor = Math.max(
            0,
            1 - Math.hypot(particle.x - mouse.x, particle.y - mouse.y) / config.cursorRadius
        );

        ctx.beginPath();
        ctx.moveTo(particle.px, particle.py);
        ctx.lineTo(particle.x, particle.y);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.16 + localCursor * 0.34})`;
        ctx.stroke();
    }

    ctx.restore();
}

function drawCursorGlow() {
    if (!mouse.active) return;

    const gradient = ctx.createRadialGradient(
        mouse.x,
        mouse.y,
        0,
        mouse.x,
        mouse.y,
        config.cursorRadius
    );

    gradient.addColorStop(0, "rgba(0, 212, 255, 0.24)");
    gradient.addColorStop(0.42, "rgba(93, 124, 255, 0.10)");
    gradient.addColorStop(1, "rgba(93, 124, 255, 0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, config.cursorRadius, 0, Math.PI * 2);
    ctx.fill();
}

function animate() {
    time += 1;

    ctx.clearRect(0, 0, width, height);

    drawCursorGlow();
    drawVectorField();
    drawParticles();

    mouse.vx *= 0.88;
    mouse.vy *= 0.88;

    requestAnimationFrame(animate);
}

window.addEventListener("resize", resize);

window.addEventListener("pointermove", (event) => {
    mouse.active = true;
    mouse.px = mouse.x;
    mouse.py = mouse.y;
    mouse.x = event.clientX;
    mouse.y = event.clientY;
    mouse.vx = mouse.x - mouse.px;
    mouse.vy = mouse.y - mouse.py;
});

window.addEventListener("pointerleave", () => {
    mouse.active = false;
});

resize();

if (!prefersReducedMotion) {
    animate();
} else {
    drawVectorField();
}