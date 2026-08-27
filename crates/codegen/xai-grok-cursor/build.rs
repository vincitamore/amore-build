fn main() {
    // prost-build shells out to protoc (found via PROTOC or PATH).
    prost_build::Config::new()
        .compile_protos(&["proto/agent.proto"], &["proto/"])
        .expect("compile agent.proto");
}
