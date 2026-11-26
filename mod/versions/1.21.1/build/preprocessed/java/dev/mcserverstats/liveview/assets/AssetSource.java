package dev.mcserverstats.liveview.assets;

import dev.mcserverstats.liveview.LogOnce;
import java.io.IOException;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

/**
 * Read-only view of {@code assets/<namespace>/...} across mod roots and the client jar. Mod roots come first so a mod
 * can override a vanilla file, the same order a resource pack stack uses. Only the asset worker touches this.
 */
public final class AssetSource implements AutoCloseable {
	private final List<Root> roots = new ArrayList<>();
	private final List<FileSystem> opened = new ArrayList<>();

	public AssetSource(Path clientJar, List<Root> modRoots) throws IOException {
		roots.addAll(modRoots);
		FileSystem jar = FileSystems.newFileSystem(clientJar);
		opened.add(jar);
		roots.add(new Root("minecraft-client", jar.getPath("/")));
	}

	public List<Root> roots() {
		return List.copyOf(roots);
	}

	public byte[] read(String path) {
		for (Root root : roots) {
			Path file = root.path().resolve(path);
			try {
				if (Files.isRegularFile(file)) {
					return Files.readAllBytes(file);
				}
			} catch (IOException e) {
				LogOnce.warn("asset-read-" + path, "Liveview could not read " + path + " from " + root.name(), e);
			}
		}
		return null;
	}

	/**
	 * Every regular file under {@code assets/<namespace>/<folder>} in every root, keyed by
	 * {@code namespace:relative/path} with the first root winning.
	 */
	public Map<String, String> list(String folder, String suffix, boolean recursive) {
		Map<String, String> found = new TreeMap<>();
		for (Root root : roots) {
			Path assets = root.path().resolve("assets");
			if (!Files.isDirectory(assets)) {
				continue;
			}
			try (Stream<Path> namespaces = Files.list(assets)) {
				for (Path namespaceDir : namespaces.toList()) {
					String namespace = name(namespaceDir);
					Path dir = namespaceDir.resolve(folder);
					if (!Files.isDirectory(dir)) {
						continue;
					}
					try (Stream<Path> files = recursive ? Files.walk(dir) : Files.list(dir)) {
						for (Path file : files.toList()) {
							String fileName = name(file);
							if (!fileName.endsWith(suffix) || !Files.isRegularFile(file)) {
								continue;
							}
							String relative = dir.relativize(file).toString().replace('\\', '/');
							relative = relative.substring(0, relative.length() - suffix.length());
							found.putIfAbsent(namespace + ":" + relative, "assets/" + namespace + "/" + folder + "/" + relative + suffix);
						}
					}
				}
			} catch (IOException e) {
				LogOnce.warn("asset-list-" + root.name() + folder, "Liveview could not list " + folder + " in " + root.name(), e);
			}
		}
		return found;
	}

	private static String name(Path path) {
		String text = path.getFileName() == null ? "" : path.getFileName().toString();
		return text.endsWith("/") ? text.substring(0, text.length() - 1) : text;
	}

	@Override
	public void close() {
		for (FileSystem fs : opened) {
			try {
				fs.close();
			} catch (IOException ignored) {
				// Closing a read-only zip file system.
			}
		}
	}

	public record Root(String name, Path path) {
	}
}
