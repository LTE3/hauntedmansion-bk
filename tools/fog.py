"""Seamless fog tile.

Built in the frequency domain with random phase and a low-pass falloff, which
is tileable by construction - so the page can drift two copies of it forever
without a visible seam or a video file.
"""
import numpy as np
from PIL import Image

N = 1024
rng = np.random.default_rng(19)
fy = np.fft.fftfreq(N)[:, None]
fx = np.fft.fftfreq(N)[None, :]
r = np.sqrt(fx ** 2 + fy ** 2)
r[0, 0] = 1e-6

amp = 1.0 / (r ** 2.1)                       # brown-ish noise = soft billows
amp[r > 0.06] = 0.0                          # cut fine detail: fog, not static
phase = rng.random((N, N)) * 2 * np.pi
f = amp * np.exp(1j * phase)
g = np.real(np.fft.ifft2(f))

g = (g - g.min()) / (g.max() - g.min())
g = np.clip((g - 0.42) / 0.45, 0, 1) ** 1.25  # thin it out so it reads as haze
Image.fromarray((g * 255).astype(np.uint8), "L").save("img/fog.png")
print("wrote img/fog.png", Image.open("img/fog.png").size)
