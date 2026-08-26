class Condense < Formula
  desc "Fast, local terminal output compression for coding agents and LLMs"
  homepage "https://github.com/5201200abc/condense"
  version "1.5.2"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/5201200abc/condense/releases/download/v#{version}/condense-darwin-arm64"
      # sha256 "..."
    end
    on_intel do
      url "https://github.com/5201200abc/condense/releases/download/v#{version}/condense-darwin-x64"
      # sha256 "..."
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/5201200abc/condense/releases/download/v#{version}/condense-linux-arm64"
      # sha256 "..."
    end
    on_intel do
      url "https://github.com/5201200abc/condense/releases/download/v#{version}/condense-linux-x64"
      # sha256 "..."
    end
  end

  def install
    binary_name = OS.mac? ? (Hardware::CPU.arm? ? "condense-darwin-arm64" : "condense-darwin-x64") : (Hardware::CPU.arm? ? "condense-linux-arm64" : "condense-linux-x64")
    bin.install binary_name => "condense"
  end

  test do
    assert_match "condense", shell_output("#{bin}/condense --help")
  end
end
