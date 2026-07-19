import SwiftUI

/// Sidetrack menu-bar app entry point.
///
/// A menu-bar-only (LSUIElement) MenuBarExtra: a status glyph + a short
/// label in the bar, and a dropdown (`.window` style so it can host the
/// richer detail view). The controller starts its ~3s poll loop when
/// the scene appears.
@main
struct SidetrackApp: App {
    @StateObject private var controller = CompanionController()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(controller: controller)
                .onAppear { controller.start() }
        } label: {
            // The bar shows the status glyph tinted by state plus a
            // one-word label so the user can eyeball up/down/busy
            // without opening the dropdown.
            HStack(spacing: 3) {
                Image(systemName: controller.status.glyphName)
                Text(controller.status.barLabel)
            }
        }
        .menuBarExtraStyle(.window)
    }
}
