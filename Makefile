.PHONY: all omnilock anyone-can-pay xudt spore ckb-js-vm nostr-lock

all: omnilock anyone-can-pay xudt spore ckb-js-vm nostr-lock

omnilock:
	@echo "Building omnilock via submodule"
	cd ckb/omnilock && git submodule update --init && make all-via-docker
	cp ckb/omnilock/build/always_success ckb/devnet/specs/
	cp ckb/omnilock/build/omni_lock ckb/devnet/specs/

anyone-can-pay:
	@echo "Building anyone-can-pay via submodule"
	cd ckb/anyone-can-pay && git submodule update --init && make all-via-docker
	cp ckb/anyone-can-pay/build/anyone_can_pay ckb/devnet/specs/

xudt:
	@echo "Building xUDT via submodule"
	cd ckb/ckb-production-scripts && git submodule update --init && make all-via-docker
	cp ckb/ckb-production-scripts/build/xudt_rce ckb/devnet/specs/
	cp ckb/ckb-production-scripts/build/simple_udt ckb/devnet/specs/sudt

spore:
	@echo "Building Spore via submodule"
	cd ckb/spore-contract && cargo install cross --git https://github.com/cross-rs/cross
	cd ckb/spore-contract && capsule build --release
	cp ckb/spore-contract/build/release/spore ckb/devnet/specs/spore-scripts/
	cp ckb/spore-contract/build/release/cluster ckb/devnet/specs/spore-scripts/
	cp ckb/spore-contract/build/release/cluster_agent ckb/devnet/specs/spore-scripts/
	cp ckb/spore-contract/build/release/cluster_proxy ckb/devnet/specs/spore-scripts/
	cp ckb/spore-contract/build/release/spore_extension_lua ckb/devnet/specs/spore-scripts/

ckb-js-vm:
	@echo "Building ckb-js-vm via submodule"
	cd ckb/ckb-js-vm && git submodule update --init && make all
	cp ckb/ckb-js-vm/build/ckb-js-vm ckb/devnet/specs/ckb_js_vm

nostr-lock:
	@echo "Building nostr-lock via submodule"
	cd ckb/nostr-binding && make build
	cp ckb/nostr-binding/build/release/nostr-lock ckb/devnet/specs/nostr_lock
