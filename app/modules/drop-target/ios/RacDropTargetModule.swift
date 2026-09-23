import ExpoModulesCore
import UIKit

/// Taking what another app drops on this one. iOS only: an Android phone has
/// no system-wide drag between apps, and the picker is the way in there.
///
/// The interaction is put on the window rather than on a view of its own. A
/// view would have to be a Fabric view, and this app does not link Expo's
/// Fabric bridge — but the deciding reason is what it does for the person: a
/// screenshot dragged anywhere over the chat lands, instead of having to be
/// let go over one particular rectangle while a finger is already busy
/// holding the drag.
public class RacDropTargetModule: Module {
  private var receiver: DropReceiver?

  public func definition() -> ModuleDefinition {
    Name("RacDropTarget")

    Events("onDrop", "onDragEnter", "onDragExit")

    /// Start accepting drops. Called by the screen that wants them, and
    /// balanced by `stop` when it goes away — a chat that is no longer on
    /// screen should not be collecting files.
    AsyncFunction("start") { [weak self] in
      guard let self else { return }
      if self.receiver != nil { return }
      guard let window = Self.window() else { return }
      let receiver = DropReceiver { [weak self] name, payload in
        self?.sendEvent(name, payload)
      }
      let interaction = UIDropInteraction(delegate: receiver)
      receiver.interaction = interaction
      receiver.host = window
      window.addInteraction(interaction)
      self.receiver = receiver
    }
    .runOnQueue(.main)

    AsyncFunction("stop") { [weak self] in
      self?.detach()
    }
    .runOnQueue(.main)

    OnDestroy { [weak self] in
      self?.detach()
    }
  }

  private func detach() {
    guard let receiver, let interaction = receiver.interaction else {
      self.receiver = nil
      return
    }
    receiver.host?.removeInteraction(interaction)
    self.receiver = nil
  }

  private static func window() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    return windows.first { $0.isKeyWindow } ?? windows.first
  }
}
