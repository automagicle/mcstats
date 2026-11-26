package dev.mcserverstats.liveview.assets;

import dev.mcserverstats.liveview.LogOnce;
import dev.mcserverstats.liveview.json.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Locale;

/**
 * Finds a Minecraft client jar for the running version: the operator's {@code assets.client-jar}, a cached download
 * whose SHA-1 still matches the hash recorded when it was fetched, or a fresh download from Mojang's version manifest
 * checked against the SHA-1 the manifest publishes. Runs on a worker thread only.
 */
public final class ClientJar {
	static final String MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
	private static final long MAX_JAR_BYTES = 256L * 1024 * 1024;
	private static final int MAX_JSON_BYTES = 4 * 1024 * 1024;

	private ClientJar() {
	}

	public static Path resolve(String configured, boolean download, Path cacheDir, String version) throws AssetException {
		if (configured != null && !configured.isBlank()) {
			Path path = Path.of(configured.trim());
			if (!Files.isRegularFile(path)) {
				throw new AssetException("assets.client-jar does not exist: " + path);
			}
			LogOnce.logger().info("Liveview using the operator's client jar {} (not hash-checked)", path);
			return path;
		}
		Path jar = cacheDir.resolve("client-" + safe(version) + ".jar");
		Path hashFile = cacheDir.resolve("client-" + safe(version) + ".jar.sha1");
		try {
			if (Files.isRegularFile(jar) && Files.isRegularFile(hashFile)) {
				String expected = Files.readString(hashFile, StandardCharsets.US_ASCII).trim().toLowerCase(Locale.ROOT);
				String actual = sha1(jar);
				if (expected.equals(actual)) {
					return jar;
				}
				LogOnce.logger().warn("Liveview cached client jar {} has SHA-1 {} but {} was recorded; downloading again", jar, actual, expected);
			}
		} catch (IOException e) {
			LogOnce.warn("client-cache-read", "Liveview could not read the cached client jar", e);
		}
		if (!download) {
			throw new AssetException("no client jar: assets.client-jar is empty and assets.download-client-jar is false");
		}
		return download(cacheDir, jar, hashFile, version);
	}

	private static Path download(Path cacheDir, Path jar, Path hashFile, String version) throws AssetException {
		HttpClient http = HttpClient.newBuilder()
				.connectTimeout(Duration.ofSeconds(15))
				.followRedirects(HttpClient.Redirect.NORMAL)
				.build();
		String versionUrl = null;
		try {
			Json.Obj manifest = object(fetchText(http, MANIFEST));
			Json.Arr versions = manifest.array("versions");
			if (versions != null) {
				for (Json.Value item : versions.items()) {
					if (item instanceof Json.Obj entry && version.equals(entry.string("id"))) {
						versionUrl = entry.string("url");
						break;
					}
				}
			}
			if (versionUrl == null) {
				throw new AssetException("version " + version + " is not in " + MANIFEST);
			}
			requireMojang(versionUrl);
			Json.Obj meta = object(fetchText(http, versionUrl));
			Json.Obj downloads = meta.object("downloads");
			Json.Obj client = downloads == null ? null : downloads.object("client");
			String url = client == null ? null : client.string("url");
			String sha1 = client == null ? null : client.string("sha1");
			if (url == null || sha1 == null) {
				throw new AssetException("version JSON " + versionUrl + " has no client download");
			}
			requireMojang(url);
			Files.createDirectories(cacheDir);
			Path partial = cacheDir.resolve(jar.getFileName() + ".part");
			LogOnce.logger().info("Liveview downloading the {} client jar from {}", version, url);
			String actual = fetchFile(http, url, partial);
			if (!actual.equalsIgnoreCase(sha1)) {
				Files.deleteIfExists(partial);
				throw new AssetException("client jar hash mismatch for " + url + ": expected SHA-1 " + sha1 + ", got " + actual);
			}
			Files.move(partial, jar, StandardCopyOption.REPLACE_EXISTING);
			Files.writeString(hashFile, sha1.toLowerCase(Locale.ROOT) + "\n", StandardCharsets.US_ASCII);
			LogOnce.logger().info("Liveview cached the client jar at {} (SHA-1 {})", jar, sha1);
			return jar;
		} catch (IOException e) {
			throw new AssetException("client jar download failed (" + (versionUrl == null ? MANIFEST : versionUrl) + "): " + e.getMessage());
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new AssetException("client jar download interrupted");
		} catch (Json.JsonException e) {
			throw new AssetException("Mojang returned JSON that does not parse: " + e.getMessage());
		}
	}

	private static void requireMojang(String url) throws AssetException {
		URI uri;
		try {
			uri = URI.create(url);
		} catch (IllegalArgumentException e) {
			throw new AssetException("bad download URL " + url);
		}
		String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
		if (!"https".equals(uri.getScheme()) || !(host.equals("mojang.com") || host.endsWith(".mojang.com"))) {
			throw new AssetException("refusing a client download outside https://*.mojang.com: " + url);
		}
	}

	private static Json.Obj object(String text) throws Json.JsonException {
		if (Json.parse(text) instanceof Json.Obj obj) {
			return obj;
		}
		throw new Json.JsonException("expected an object");
	}

	private static String fetchText(HttpClient http, String url) throws IOException, InterruptedException {
		HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(30)).GET().build();
		HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
		try (InputStream in = response.body()) {
			if (response.statusCode() != 200) {
				throw new IOException("HTTP " + response.statusCode() + " from " + url);
			}
			byte[] bytes = in.readNBytes(MAX_JSON_BYTES + 1);
			if (bytes.length > MAX_JSON_BYTES) {
				throw new IOException(url + " is larger than " + MAX_JSON_BYTES + " bytes");
			}
			return new String(bytes, StandardCharsets.UTF_8);
		}
	}

	private static String fetchFile(HttpClient http, String url, Path target) throws IOException, InterruptedException {
		HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMinutes(10)).GET().build();
		HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
		MessageDigest digest = sha1Digest();
		long total = 0;
		try (InputStream in = response.body(); OutputStream out = Files.newOutputStream(target)) {
			if (response.statusCode() != 200) {
				throw new IOException("HTTP " + response.statusCode() + " from " + url);
			}
			byte[] buffer = new byte[64 * 1024];
			int read;
			while ((read = in.read(buffer)) >= 0) {
				total += read;
				if (total > MAX_JAR_BYTES) {
					throw new IOException(url + " is larger than " + MAX_JAR_BYTES + " bytes");
				}
				digest.update(buffer, 0, read);
				out.write(buffer, 0, read);
			}
		} catch (IOException e) {
			Files.deleteIfExists(target);
			throw e;
		}
		return HexFormat.of().formatHex(digest.digest());
	}

	static String sha1(Path file) throws IOException {
		MessageDigest digest = sha1Digest();
		try (InputStream in = Files.newInputStream(file)) {
			byte[] buffer = new byte[64 * 1024];
			int read;
			while ((read = in.read(buffer)) >= 0) {
				digest.update(buffer, 0, read);
			}
		}
		return HexFormat.of().formatHex(digest.digest());
	}

	private static MessageDigest sha1Digest() {
		try {
			return MessageDigest.getInstance("SHA-1");
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException("JDK has no SHA-1", e);
		}
	}

	private static String safe(String version) {
		return version.replaceAll("[^A-Za-z0-9._-]", "_");
	}
}
