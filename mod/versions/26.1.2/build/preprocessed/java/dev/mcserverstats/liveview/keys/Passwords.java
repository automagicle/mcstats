package dev.mcserverstats.liveview.keys;

import dev.mcserverstats.liveview.LogOnce;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.spec.KeySpec;
import java.util.Arrays;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

public final class Passwords {
	public static final int ITERATIONS = 100_000;
	private static final char[] ALPHABET =
			"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789".toCharArray();
	private static final int PASSWORD_LENGTH = 20;
	private static final int KEY_BITS = 256;

	private final byte[] salt;
	private final byte[] hash;
	private final int iterations;

	public Passwords(byte[] salt, byte[] hash, int iterations) {
		this.salt = salt.clone();
		this.hash = hash.clone();
		this.iterations = iterations;
	}

	public static Generated generate() {
		SecureRandom random = new SecureRandom();
		byte[] salt = new byte[16];
		random.nextBytes(salt);
		char[] password = new char[PASSWORD_LENGTH];
		for (int i = 0; i < password.length; i++) {
			password[i] = ALPHABET[random.nextInt(ALPHABET.length)];
		}
		byte[] hash = derive(password, salt, ITERATIONS);
		String text = new String(password);
		Arrays.fill(password, '\0');
		return new Generated(text, salt, hash, ITERATIONS);
	}

	public boolean verify(String password) {
		if (password == null || password.length() > 256) {
			return false;
		}
		char[] chars = clean(password).toCharArray();
		try {
			byte[] derived = derive(chars, salt, iterations);
			return MessageDigest.isEqual(derived, hash);
		} catch (RuntimeException e) {
			LogOnce.warn("pbkdf2", "Liveview could not check the password", e);
			return false;
		} finally {
			Arrays.fill(chars, '\0');
		}
	}

	/**
	 * Generated passwords are letters and digits only, so whitespace and the quotes or backticks that come along when a
	 * password is copied from chat, a log or Markdown (`abc`) are dropped from both ends instead of failing the login.
	 */
	public static String clean(String password) {
		String text = password.strip();
		int start = 0;
		int end = text.length();
		while (start < end && "`'\"\u2018\u2019\u201C\u201D".indexOf(text.charAt(start)) >= 0) {
			start++;
		}
		while (end > start && "`'\"\u2018\u2019\u201C\u201D".indexOf(text.charAt(end - 1)) >= 0) {
			end--;
		}
		return text.substring(start, end).strip();
	}

	private static byte[] derive(char[] password, byte[] salt, int iterations) {
		KeySpec spec = new PBEKeySpec(password, salt, iterations, KEY_BITS);
		try {
			return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
		} catch (GeneralSecurityException e) {
			throw new IllegalStateException("PBKDF2WithHmacSHA256 is unavailable", e);
		} finally {
			if (spec instanceof PBEKeySpec pbe) {
				pbe.clearPassword();
			}
		}
	}

	public record Generated(String password, byte[] salt, byte[] hash, int iterations) {
	}
}
