package dev.mcserverstats.liveview.assets;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import javax.imageio.ImageIO;

/** PNG decode and encode through the JDK's ImageIO. Pixels are packed ARGB. */
public final class Png {
	private Png() {
	}

	public static Image decode(byte[] bytes) throws IOException {
		if (bytes == null) {
			throw new IOException("missing PNG");
		}
		BufferedImage image = ImageIO.read(new ByteArrayInputStream(bytes));
		if (image == null) {
			throw new IOException("not a PNG");
		}
		int w = image.getWidth();
		int h = image.getHeight();
		if (w <= 0 || h <= 0 || (long) w * h > 16L * 1024 * 1024) {
			throw new IOException("PNG size out of range: " + w + "x" + h);
		}
		int[] pixels = isGray(image) ? grayPixels(image, w, h) : image.getRGB(0, 0, w, h, null, 0, w);
		return new Image(w, h, pixels);
	}

	/**
	 * ImageIO gives grayscale PNGs (color types 0 and 4) a linear gray color space, so {@code getRGB} "converts" them to
	 * sRGB and brightens every pixel (a stone texel stored as 143 came back as 197). PNG gray samples are already the
	 * display values, so they are read straight from the raster: band 0 is gray, band 1 (if present) is alpha.
	 */
	private static boolean isGray(BufferedImage image) {
		return image.getColorModel().getColorSpace().getType() == java.awt.color.ColorSpace.TYPE_GRAY;
	}

	private static int[] grayPixels(BufferedImage image, int w, int h) {
		java.awt.image.Raster raster = image.getRaster();
		int bands = raster.getNumBands();
		int grayBits = image.getColorModel().getComponentSize(0);
		int alphaBits = bands > 1 ? image.getColorModel().getComponentSize(1) : 8;
		int grayMax = (1 << grayBits) - 1;
		int alphaMax = (1 << alphaBits) - 1;
		int[] pixels = new int[w * h];
		for (int y = 0; y < h; y++) {
			for (int x = 0; x < w; x++) {
				int g = raster.getSample(x, y, 0) * 255 / grayMax;
				int a = bands > 1 ? raster.getSample(x, y, 1) * 255 / alphaMax : 255;
				pixels[y * w + x] = a << 24 | g << 16 | g << 8 | g;
			}
		}
		return pixels;
	}

	public static byte[] encode(Image image) throws IOException {
		BufferedImage out = new BufferedImage(image.width(), image.height(), BufferedImage.TYPE_INT_ARGB);
		out.setRGB(0, 0, image.width(), image.height(), image.pixels(), 0, image.width());
		ByteArrayOutputStream bytes = new ByteArrayOutputStream();
		if (!ImageIO.write(out, "png", bytes)) {
			throw new IOException("no PNG writer");
		}
		return bytes.toByteArray();
	}

	public record Image(int width, int height, int[] pixels) {
		public int argb(int x, int y) {
			return pixels[y * width + x];
		}

		/** True when some pixel is neither fully opaque nor fully clear. */
		public boolean translucent(int top, int rows) {
			int end = Math.min(height, top + rows);
			for (int y = top; y < end; y++) {
				for (int x = 0; x < width; x++) {
					int alpha = pixels[y * width + x] >>> 24;
					if (alpha != 0 && alpha != 255) {
						return true;
					}
				}
			}
			return false;
		}

		/** True when every pixel in the rows is fully opaque. */
		public boolean opaque(int top, int rows) {
			int end = Math.min(height, top + rows);
			for (int y = top; y < end; y++) {
				for (int x = 0; x < width; x++) {
					if (pixels[y * width + x] >>> 24 != 255) {
						return false;
					}
				}
			}
			return true;
		}
	}
}
