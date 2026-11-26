package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;

/**
 * Fabric Loader 0.20.1, VERIFIED by javap in Phase 4: {@code FabricLoader.getAllMods()},
 * {@code ModContainer.getRootPaths()}, {@code ModContainer.getMetadata()}, {@code ModContainer.getContainingMod()}.
 * {@code getAllMods()} lists nested jar-in-jar mods as their own containers, and their root paths open the nested
 * jar, so nested mod assets are scanned the same way as top-level ones.
 */
public final class AssetEnvironment {
	private static final Set<String> SKIP = Set.of("minecraft", "java", "fabricloader", "liveview", "mixinextras");

	private AssetEnvironment() {
	}

	public static String minecraftVersion() {
		try {
			return FabricLoader.getInstance()
					.getModContainer("minecraft")
					.map(container -> container.getMetadata().getVersion().getFriendlyString())
					.orElse("26.2");
		} catch (Throwable thrown) {
			LogOnce.warn("mc-version", "Liveview could not read the Minecraft version; assuming 26.2", thrown);
			return "26.2";
		}
	}

	/** Root paths of every installed mod except Minecraft itself, Java, and the loader. */
	public static List<ModRoot> modRoots() {
		List<ModRoot> roots = new ArrayList<>();
		try {
			for (ModContainer container : FabricLoader.getInstance().getAllMods()) {
				String id = container.getMetadata().getId();
				if (SKIP.contains(id)) {
					continue;
				}
				for (Path root : container.getRootPaths()) {
					roots.add(new ModRoot(id, root));
				}
			}
		} catch (Throwable thrown) {
			LogOnce.warn("mod-roots", "Liveview could not list mod jars; only vanilla assets will load", thrown);
		}
		return roots;
	}

	public record ModRoot(String modId, Path root) {
	}
}
