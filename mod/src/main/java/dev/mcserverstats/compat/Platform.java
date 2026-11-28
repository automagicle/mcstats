package dev.mcserverstats.compat;

// What differs between the Fabric mod and the Paper plugin in what the mod says, not in what it does: where its
// files are and where its jar goes. Set once by the entry point (FabricEntry, PaperPlugin) before anything else
// runs; the defaults are Fabric's.
public final class Platform {
	private Platform() {
	}

	private static volatile String name = "Fabric";
	private static volatile String configFolder = "config/";
	private static volatile String jarFolder = "mods/";

	public static void set(String name, String configFolder, String jarFolder) {
		Platform.name = name;
		Platform.configFolder = configFolder;
		Platform.jarFolder = jarFolder;
	}

	// "Fabric" or "Paper", for log lines and the User-Agent.
	public static String name() {
		return name;
	}

	// Where the mod's files are, as a server owner would find them: "config/" or "plugins/mcstats/".
	public static String configFolder() {
		return configFolder;
	}

	// Where its jar goes: "mods/" or "plugins/".
	public static String jarFolder() {
		return jarFolder;
	}
}
