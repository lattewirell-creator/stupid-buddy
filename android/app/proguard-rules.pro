# The page calls the bridge through Android's JavaScript interface; the annotation must survive for WebView to expose it.
-keepattributes RuntimeVisibleAnnotations
-keep class com.emil.stupidbuddy.Bridge { @android.webkit.JavascriptInterface public <methods>; }
