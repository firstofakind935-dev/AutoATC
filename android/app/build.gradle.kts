// AutoATC Radio for Android: talk to the AI (and human) controllers through the radio hub, with a floating
// push-to-talk button over the game. Built by .github/workflows/build-apk.yml; VERSION_CODE comes from the build number.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val buildNumber = (System.getenv("VERSION_CODE") ?: "1").toInt()

android {
    namespace = "com.autoatc.radio"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.autoatc.radio"
        minSdk = 26 // floating overlay windows (TYPE_APPLICATION_OVERLAY)
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // The same key must sign every build, or Android refuses to install an update over the old app. The key comes
    // from the CI secrets (see the workflow); without them the build is signed with a throwaway debug key.
    val keystore = System.getenv("KEYSTORE_FILE")
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (keystore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
