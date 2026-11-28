package dev.mcserverstats.liveview.mc;

import dev.mcserverstats.liveview.LogOnce;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Supplier;

/**
 * What Liveview's texture packing needs to know about the installation: the game's version (which client jar to
 * fetch) and the jars of other installed mods (their block and item textures). The entry point sets both once at
 * start ({@link #set}): on Fabric from Fabric Loader (FabricEntry); on Paper, which has no mods that add blocks,
 * the version alone.
 */
public final class AssetEnvironment {
	private static volatile String minecraft = "26.2";
	private static volatile Supplier<List<ModRoot>> roots = List::of;

	private AssetEnvironment() {
	}

	public static void set(String minecraftVersion, Supplier<List<ModRoot>> modRoots) {
		if (minecraftVersion != null && !minecraftVersion.isBlank()) {
			minecraft = minecraftVersion;
		}
		roots = modRoots == null ? List::of : modRoots;
	}

	public static String minecraftVersion() {
		return minecraft;
	}

	/** Root paths of every installed mod except Minecraft itself, Java, and the loader. */
	public static List<ModRoot> modRoots() {
		try {
			return roots.get();
		} catch (Throwable thrown) {
			LogOnce.warn("mod-roots", "Liveview could not list mod jars; only vanilla assets will load", thrown);
			return List.of();
		}
	}

	public record ModRoot(String modId, Path root) {
	}
}
