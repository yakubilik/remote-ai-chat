import UIKit
import UniformTypeIdentifiers

/// Everything from one drag is copied under a folder of its own. The system
/// hands over a URL that is deleted the moment the closure returns, so the
/// copy is not an optimisation — it is the only way the file still exists by
/// the time JavaScript hears about it.
private let INBOX = "rac-drops"

/// A drag can carry a whole album. More than this is a mis-grab rather than an
/// intention, and every one of them is an upload over the local network.
private let MAX_ITEMS = 8

/// The UIKit half: it answers the drag session and turns what lands into files
/// on disk. It knows nothing about Expo beyond the closure it reports through.
class DropReceiver: NSObject, UIDropInteractionDelegate {
  typealias Emit = (_ event: String, _ payload: [String: Any]) -> Void

  private let emit: Emit
  /// Held so the module can take the interaction off again.
  var interaction: UIDropInteraction?
  weak var host: UIView?

  init(emit: @escaping Emit) {
    self.emit = emit
  }

  // MARK: - the session

  func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
    // Anything with a file behind it. The agent reads whatever it is handed,
    // so narrowing this to images would turn a working drop into a silent
    // refusal for the PDF someone dragged over.
    session.hasItemsConforming(toTypeIdentifiers: [UTType.item.identifier])
  }

  func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal {
    UIDropProposal(operation: .copy)
  }

  func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnter session: UIDropSession) {
    emit("onDragEnter", [:])
  }

  func dropInteraction(_ interaction: UIDropInteraction, sessionDidExit session: UIDropSession) {
    emit("onDragExit", [:])
  }

  func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnd session: UIDropSession) {
    emit("onDragExit", [:])
  }

  func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
    emit("onDragExit", [:])
    let items = Array(session.items.prefix(MAX_ITEMS))
    let group = DispatchGroup()
    let lock = NSLock()
    // Keyed by position so the order they were dragged in survives loads that
    // finish in whatever order they finish.
    var byIndex: [Int: [String: Any]] = [:]

    for (index, item) in items.enumerated() {
      group.enter()
      ingest(item.itemProvider) { file in
        if let file {
          lock.lock()
          byIndex[index] = file
          lock.unlock()
        }
        group.leave()
      }
    }

    group.notify(queue: .main) { [weak self] in
      let files = items.indices.compactMap { byIndex[$0] }
      self?.emit("onDrop", ["files": files])
    }
  }

  // MARK: - getting it onto disk

  private func ingest(_ provider: NSItemProvider, completion: @escaping ([String: Any]?) -> Void) {
    guard let typeId = fileType(of: provider) else {
      ingestAsImage(provider, completion: completion)
      return
    }
    provider.loadFileRepresentation(forTypeIdentifier: typeId) { [weak self] url, _ in
      guard let url else {
        // A picture held only as pixels — one straight off the clipboard, say
        // — has no file to hand over. It still has an image.
        if let self {
          self.ingestAsImage(provider, completion: completion)
        } else {
          completion(nil)
        }
        return
      }
      // The URL is gone the moment this closure returns, so the copy happens
      // first and the questions are asked afterwards.
      let name = Self.name(provider.suggestedName, like: url.lastPathComponent)
      completion(Self.keep(url, as: name))
    }
  }

  /// The type to ask for a file in. The first registered identifier is the
  /// sender's own preference, which is what the file should be written as — a
  /// screenshot offered as both HEIC and JPEG arrives as the one Photos put
  /// first.
  private func fileType(of provider: NSItemProvider) -> String? {
    provider.registeredTypeIdentifiers.first { id in
      guard let type = UTType(id) else { return false }
      // A URL or a bare string is a reference, not a file: written out as one
      // it becomes a text file containing a path, which helps nobody.
      if type.conforms(to: .url) || type.conforms(to: .plainText) { return false }
      return provider.hasItemConformingToTypeIdentifier(id)
    }
  }

  private func ingestAsImage(_ provider: NSItemProvider, completion: @escaping ([String: Any]?) -> Void) {
    guard provider.canLoadObject(ofClass: UIImage.self) else {
      completion(nil)
      return
    }
    provider.loadObject(ofClass: UIImage.self) { object, _ in
      guard let image = object as? UIImage, let data = image.jpegData(compressionQuality: 0.9) else {
        completion(nil)
        return
      }
      let name = Self.name(provider.suggestedName, like: "image.jpg")
      completion(Self.write(data, as: name))
    }
  }

  /// What to call the file. The sender's own name is used when it has one, and
  /// keeps the extension of the thing actually written — a name without one is
  /// a file nothing can guess the type of, on either side of the upload.
  private static func name(_ suggested: String?, like fallback: String) -> String {
    let ext = (fallback as NSString).pathExtension
    guard let suggested, !suggested.isEmpty else { return fallback }
    let clean = suggested.replacingOccurrences(of: "/", with: "-")
    if (clean as NSString).pathExtension.isEmpty && !ext.isEmpty {
      return "\(clean).\(ext)"
    }
    return clean
  }

  private static func keep(_ url: URL, as name: String) -> [String: Any]? {
    do {
      let target = try destination(for: name)
      try FileManager.default.copyItem(at: url, to: target)
      return describe(target)
    } catch {
      return nil
    }
  }

  private static func write(_ data: Data, as name: String) -> [String: Any]? {
    do {
      let target = try destination(for: name)
      try data.write(to: target)
      return describe(target)
    } catch {
      return nil
    }
  }

  /// A folder of its own per file keeps two of the same name apart without
  /// renaming either: what was dropped is what the agent is told it was sent.
  private static func destination(for name: String) throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent(INBOX, isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent(name)
  }

  private static func describe(_ url: URL) -> [String: Any] {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
    return ["uri": url.absoluteString, "name": url.lastPathComponent, "size": size]
  }
}
