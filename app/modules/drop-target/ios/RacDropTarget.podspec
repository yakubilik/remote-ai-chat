Pod::Spec.new do |s|
  s.name           = 'RacDropTarget'
  s.version        = '1.0.0'
  s.summary        = 'A view that accepts files dragged in from another app.'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'remote-ai-chat'
  s.homepage       = 'https://github.com/yakubilik/remote-ai-chat'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/yakubilik/remote-ai-chat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
