package dev.droiddesk.uihelper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeoutException;

/**
 * Droid Desk UI helper for test automation.
 *
 * Runs on the phone as a shell process (app_process), like `uiautomator` and the scrcpy server:
 * nothing is installed, and it exits when Droid Desk closes the connection. It keeps one
 * UiAutomation session open, so reading the screen takes milliseconds instead of the seconds
 * `uiautomator dump` needs to start a new process each time.
 *
 * Protocol: one command per line on stdin, one reply line on stdout.
 *   dump                      -> {"w":..,"h":..,"rot":..,"windows":[{...,"root":{node}}]}
 *   idle <quietMs> <maxMs>    -> OK | TIMEOUT
 *   tap <x> <y> [holdMs]      -> OK
 *   swipe <x1> <y1> <x2> <y2> <ms> -> OK
 *   key <keyCode>             -> OK
 *   text <base64 utf-8>       -> OK   (typed as key presses; falls back to setting the focused field)
 *   quit
 * Errors reply "ERR <message>".
 */
public final class Main {
    private static UiAutomation ua;
    private static final int MAX_NODES = 6000;
    private static int nodeCount;

    public static void main(String[] args) {
        PrintStream out = new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), false);
        try {
            connect();
        } catch (Throwable t) {
            say(out, "ERR " + oneLine(t));
            System.exit(1);
            return;
        }
        say(out, "READY " + Build.VERSION.SDK_INT);
        try {
            BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            String line;
            while ((line = in.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                if (line.equals("quit")) break;
                String reply;
                try {
                    reply = handle(line.split(" "));
                } catch (Throwable t) {
                    reply = "ERR " + oneLine(t);
                }
                say(out, reply);
            }
        } catch (Throwable ignored) {
        }
        try { UiAutomation.class.getDeclaredMethod("disconnect").invoke(ua); } catch (Throwable ignored) { }
        System.exit(0);
    }

    private static void say(PrintStream out, String s) {
        out.print(s);
        out.print('\n');
        out.flush();
    }

    private static String oneLine(Throwable t) {
        Throwable c = t;
        while (c.getCause() != null && (c instanceof java.lang.reflect.InvocationTargetException || c.getMessage() == null)) c = c.getCause();
        return (c.getClass().getSimpleName() + ": " + c.getMessage()).replace('\n', ' ').replace('\r', ' ');
    }

    private static void connect() throws Exception {
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        HandlerThread thread = new HandlerThread("dd-ui-helper");
        thread.start();
        Class<?> connClass = Class.forName("android.app.UiAutomationConnection");
        Object conn = connClass.getDeclaredConstructor().newInstance();
        Class<?> iface = Class.forName("android.app.IUiAutomationConnection");
        ua = UiAutomation.class.getDeclaredConstructor(Looper.class, iface).newInstance(thread.getLooper(), conn);
        try {
            // 1 = FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES: keep TalkBack etc. running during tests.
            UiAutomation.class.getDeclaredMethod("connect", int.class).invoke(ua, 1);
        } catch (NoSuchMethodException e) {
            UiAutomation.class.getDeclaredMethod("connect").invoke(ua);
        }
        AccessibilityServiceInfo info = ua.getServiceInfo();
        if (info != null) {
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                    | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            ua.setServiceInfo(info);
        }
    }

    private static String handle(String[] a) throws Exception {
        switch (a[0]) {
            case "dump":
                return dump();
            case "idle":
                try {
                    ua.waitForIdle(Long.parseLong(a[1]), Long.parseLong(a[2]));
                    return "OK";
                } catch (TimeoutException e) {
                    return "TIMEOUT";
                }
            case "tap": {
                float x = Float.parseFloat(a[1]), y = Float.parseFloat(a[2]);
                long hold = a.length > 3 ? Long.parseLong(a[3]) : 60;
                long down = SystemClock.uptimeMillis();
                touch(down, down, MotionEvent.ACTION_DOWN, x, y);
                if (hold > 0) Thread.sleep(hold);
                touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y);
                return "OK";
            }
            case "swipe": {
                float x1 = Float.parseFloat(a[1]), y1 = Float.parseFloat(a[2]);
                float x2 = Float.parseFloat(a[3]), y2 = Float.parseFloat(a[4]);
                long ms = Math.max(50, Long.parseLong(a[5]));
                long down = SystemClock.uptimeMillis();
                touch(down, down, MotionEvent.ACTION_DOWN, x1, y1);
                long now;
                while ((now = SystemClock.uptimeMillis()) - down < ms) {
                    float f = (now - down) / (float) ms;
                    touch(down, now, MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f);
                    Thread.sleep(8);
                }
                now = SystemClock.uptimeMillis();
                touch(down, now, MotionEvent.ACTION_MOVE, x2, y2);
                // A short rest at the end point, so the swipe drags instead of flinging further.
                Thread.sleep(40);
                touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x2, y2);
                return "OK";
            }
            case "key": {
                int code = Integer.parseInt(a[1]);
                long now = SystemClock.uptimeMillis();
                key(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD));
                key(new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD));
                return "OK";
            }
            case "text":
                return text(new String(android.util.Base64.decode(a.length > 1 ? a[1] : "", android.util.Base64.DEFAULT), StandardCharsets.UTF_8));
            default:
                return "ERR unknown command";
        }
    }

    private static void touch(long down, long when, int action, float x, float y) {
        MotionEvent e = MotionEvent.obtain(down, when, action, x, y, 0);
        e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        ua.injectInputEvent(e, true);
        e.recycle();
    }

    private static void key(KeyEvent e) {
        ua.injectInputEvent(e, true);
    }

    private static String text(String s) {
        KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(s.toCharArray());
        if (events != null) {
            for (KeyEvent e : events) {
                key(KeyEvent.changeTimeRepeat(e, SystemClock.uptimeMillis(), 0));
            }
            return "OK";
        }
        // Characters with no key (accents, other scripts, emoji): add them to the focused field directly.
        AccessibilityNodeInfo focus = ua.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focus == null) return "ERR No text field is focused";
        CharSequence old = focus.getText();
        String now = (old == null || focus.isShowingHintText() ? "" : old.toString()) + s;
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, now);
        boolean ok = focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
        if (ok) {
            Bundle sel = new Bundle();
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, now.length());
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, now.length());
            focus.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
        }
        return ok ? "OK" : "ERR The focused field did not accept the text";
    }

    // ---------- screen contents ----------

    private static String dump() throws Exception {
        JSONObject res = new JSONObject();
        int[] d = display();
        if (d != null) {
            res.put("w", d[0]);
            res.put("h", d[1]);
            res.put("rot", d[2]);
        }
        JSONArray windows = new JSONArray();
        nodeCount = 0;
        List<AccessibilityWindowInfo> list = null;
        try { list = ua.getWindows(); } catch (Throwable ignored) { }
        if (list != null && !list.isEmpty()) {
            // Topmost window first, so a point is matched against what the user actually sees there.
            java.util.ArrayList<AccessibilityWindowInfo> sorted = new java.util.ArrayList<>(list);
            java.util.Collections.sort(sorted, (x, y) -> y.getLayer() - x.getLayer());
            for (AccessibilityWindowInfo w : sorted) {
                AccessibilityNodeInfo root = w.getRoot();
                if (root == null) continue;
                JSONObject jw = new JSONObject();
                jw.put("type", w.getType());
                jw.put("active", w.isActive());
                jw.put("focused", w.isFocused());
                CharSequence title = Build.VERSION.SDK_INT >= 24 ? w.getTitle() : null;
                if (title != null) jw.put("title", title.toString());
                JSONObject node = node(root, 0);
                if (node == null) continue;
                jw.put("root", node);
                windows.put(jw);
            }
        }
        if (windows.length() == 0) {
            AccessibilityNodeInfo root = ua.getRootInActiveWindow();
            if (root == null) return "ERR The screen can't be read right now";
            JSONObject jw = new JSONObject();
            jw.put("type", 1);
            jw.put("active", true);
            JSONObject node = node(root, 0);
            if (node != null) { jw.put("root", node); windows.put(jw); }
        }
        res.put("windows", windows);
        return res.toString();
    }

    private static JSONObject node(AccessibilityNodeInfo n, int depth) throws Exception {
        if (n == null || !n.isVisibleToUser() || nodeCount >= MAX_NODES || depth > 80) return null;
        nodeCount++;
        JSONObject o = new JSONObject();
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        o.put("b", new JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom));
        if (n.getClassName() != null) o.put("c", n.getClassName().toString());
        if (depth == 0 && n.getPackageName() != null) o.put("p", n.getPackageName().toString());
        if (n.getViewIdResourceName() != null) o.put("i", n.getViewIdResourceName());
        CharSequence text = n.getText();
        boolean hint = Build.VERSION.SDK_INT >= 26 && n.isShowingHintText();
        if (text != null && text.length() > 0) o.put(hint ? "h" : "t", clip(text));
        if (!hint && Build.VERSION.SDK_INT >= 26 && n.getHintText() != null && n.getHintText().length() > 0) o.put("h", clip(n.getHintText()));
        CharSequence desc = n.getContentDescription();
        if (desc != null && desc.length() > 0) o.put("d", clip(desc));
        int f = (n.isClickable() ? 1 : 0) | (n.isLongClickable() ? 2 : 0) | (n.isScrollable() ? 4 : 0) | (n.isEditable() ? 8 : 0)
                | (n.isCheckable() ? 16 : 0) | (n.isChecked() ? 32 : 0) | (n.isEnabled() ? 64 : 0) | (n.isFocused() ? 128 : 0)
                | (n.isSelected() ? 256 : 0) | (n.isPassword() ? 512 : 0);
        o.put("f", f);
        int count = n.getChildCount();
        if (count > 0) {
            JSONArray kids = new JSONArray();
            for (int i = 0; i < count; i++) {
                JSONObject k = node(n.getChild(i), depth + 1);
                if (k != null) kids.put(k);
            }
            if (kids.length() > 0) o.put("k", kids);
        }
        return o;
    }

    private static String clip(CharSequence s) {
        return s.length() > 300 ? s.subSequence(0, 300).toString() : s.toString();
    }

    /** Real display size in the current rotation, or null if the hidden API moved. */
    private static int[] display() {
        try {
            Class<?> dmg = Class.forName("android.hardware.display.DisplayManagerGlobal");
            Object inst = dmg.getMethod("getInstance").invoke(null);
            Method get = dmg.getMethod("getRealDisplay", int.class);
            android.view.Display disp = (android.view.Display) get.invoke(inst, 0);
            Point p = new Point();
            disp.getRealSize(p);
            return new int[]{p.x, p.y, disp.getRotation()};
        } catch (Throwable t) {
            return null;
        }
    }
}
