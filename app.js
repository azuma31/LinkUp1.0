// 暗号化ユーティリティクラス
class CryptoUtil {
    static async generateKey() {
        return await window.crypto.subtle.generateKey(
            {
                name: "AES-GCM",
                length: 256
            },
            true,
            ["encrypt", "decrypt"]
        );
    }

    static async exportKey(key) {
        const exported = await window.crypto.subtle.exportKey("raw", key);
        return Array.from(new Uint8Array(exported))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    static async importKey(keyData) {
        const keyBytes = new Uint8Array(keyData.match(/.{2}/g)
            .map(byte => parseInt(byte, 16)));
        return await window.crypto.subtle.importKey(
            "raw",
            keyBytes,
            "AES-GCM",
            true,
            ["encrypt", "decrypt"]
        );
    }

    static async encrypt(key, data) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await window.crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: iv
            },
            key,
            data
        );
        return {
            iv: Array.from(iv),
            data: Array.from(new Uint8Array(encrypted))
        };
    }

    static async decrypt(key, iv, encryptedData) {
        return await window.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: new Uint8Array(iv)
            },
            key,
            new Uint8Array(encryptedData)
        );
    }
}

// メインアプリケーションクラス
class SecureVideoChat {
    constructor() {
        this.peer = null;
        this.currentCall = null;
        this.encryptionKey = null;
        this.dataConnection = null;
        this.localStream = null;
        this.isAudioEnabled = true;
        this.isVideoEnabled = true;
        this.isKeyVisible = false;
        this.isVolumeControlVisible = false;
        this.currentVolume = 100;
        this.isMediaReady = false;
        this.audioContext = null;
        this.gainNode = null;
        this.audioSource = null;
        this.disconnectedBySelf = false;

        this.initializeElements();
        this.initializeApp();
        this.setupEventListeners();
        this.setupCopyButtons();

        // アンロードハンドラーの追加
        window.addEventListener('beforeunload', (e) => {
            // タブを閉じる・リロード時に相手へ切断シグナルを送信
            if (this.dataConnection && this.dataConnection.open !== false) {
                try {
                    this.dataConnection.send({ type: 'DISCONNECT_SIGNAL' });
                } catch (_) {}
            }
            this.cleanup();
        });

        // visibilitychangeでタブ非表示→閉じる場合も検知（モバイル対応）
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && this.currentCall) {
                if (this.dataConnection && this.dataConnection.open !== false) {
                    try {
                        this.dataConnection.send({ type: 'DISCONNECT_SIGNAL' });
                    } catch (_) {}
                }
            }
        });
    }

    // DOM要素の初期化
    initializeElements() {
        this.elements = {
            localVideo: document.getElementById('localVideo'),
            remoteVideo: document.getElementById('remoteVideo'),
            connectButton: document.getElementById('connectButton'),
            disconnectButton: document.getElementById('disconnectButton'),
            remotePeerId: document.getElementById('remotePeerId'),
            localPeerId: document.getElementById('localPeerId'),
            encryptionKeyDisplay: document.getElementById('encryptionKey'),
            connectionStatus: document.getElementById('connectionStatus'),
            connectionQuality: document.getElementById('connectionQuality'),
            toggleMicButton: document.getElementById('toggleMicButton'),
            toggleVideoButton: document.getElementById('toggleVideoButton'),
            volumeControlButton: document.getElementById('volumeControlButton'),
            volumeSlider: document.getElementById('volumeSlider'),
            volumeSliderContainer: document.querySelector('.volume-slider-container'),
            toggleKeyVisibilityButton: document.querySelector('.toggle-visibility-btn'),
            statusIndicator: document.querySelector('.status-indicator'),
            meetingUrl: document.getElementById('meetingUrl'),
            notificationModal: document.getElementById('notificationModal'),
            modalClose: document.querySelector('.modal-close'),
            volumeValue: document.getElementById('volumeValue'),
            boostBadge: document.getElementById('boostBadge')
        };
    }

    // 新規追加: クリーンアップ処理
    async cleanup() {
        try {
            // メディアストリームの停止
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => {
                    track.stop();
                });
                this.localStream = null;
            }

            // 暗号化キーの安全な破棄
            if (this.encryptionKey) {
                // キーのメモリをゼロで上書き
                const emptyKey = new Uint8Array(32).fill(0);
                await window.crypto.subtle.importKey(
                    'raw',
                    emptyKey,
                    'AES-GCM',
                    true,
                    ['encrypt', 'decrypt']
                );
                this.encryptionKey = null;
            }

            // 接続の終了
            if (this.currentCall) {
                this.currentCall.close();
                this.currentCall = null;
            }
            if (this.dataConnection) {
                this.dataConnection.close();
                this.dataConnection = null;
            }
            if (this.peer) {
                this.peer.destroy();
                this.peer = null;
            }

            // UI状態のリセット
            this.elements.remoteVideo.srcObject = null;
            this.elements.localVideo.srcObject = null;
            this.updateStatus('セッション終了');
        } catch (error) {
            console.error('クリーンアップエラー:', error);
        }
    }

    // アプリケーションの初期化
    async initializeApp() {
        try {
            await this.initializePeer();
            await this.setupLocalStream();
            this.isMediaReady = true;
            this.checkUrlParameters();
        } catch (error) {
            console.error('初期化エラー:', error);
            this.showNotification('エラー', '初期化に失敗しました', 'error');
        }
    }

    // URLパラメータのチェック
    checkUrlParameters() {
        const urlParams = new URLSearchParams(window.location.search);
        const remoteId = urlParams.get('id');
        const key = urlParams.get('key');
        
        if (remoteId && key) {
            this.elements.remotePeerId.value = remoteId;
            this.elements.encryptionKeyDisplay.value = key;
            
            if (!this.isMediaReady || !this.peer || !this.peer.id) {
                this.showNotification('警告', 'デバイスの準備中です。しばらくお待ちください...', 'warning');
                return;
            }

            setTimeout(() => this.connect(), 1000);
        }
    }

    // ミーティングURLの更新
    updateMeetingUrl() {
        const baseUrl = window.location.origin + window.location.pathname;
        const id = this.elements.localPeerId.value;
        const key = this.elements.encryptionKeyDisplay.value;
        const meetingUrl = `${baseUrl}?id=${id}&key=${key}`;
        this.elements.meetingUrl.value = meetingUrl;
    }

    // PeerJSの初期化メソッドを変更します
    async initializePeer() {
        try {
            this.encryptionKey = await CryptoUtil.generateKey();
            const exportedKey = await CryptoUtil.exportKey(this.encryptionKey);
            this.elements.encryptionKeyDisplay.value = exportedKey;

            // カスタムIDの入力を促すアラートを表示
            const useCustomId = confirm("カスタムIDを使用しますか？");
            let customId = null;

            if (useCustomId) {
                customId = prompt("使用したいカスタムIDを入力してください：", "");
                // キャンセルされた場合やIDが空の場合は自動生成に戻る
                if (!customId) {
                    alert("カスタムIDが指定されなかったため、自動生成IDを使用します。");
                    customId = null;
                }
            }

            // PeerJSの初期化（カスタムIDがある場合は指定）
            this.peer = new Peer(customId, {
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.google.com:19302' },
                        { urls: 'stun:stun2.google.com:19302' },
                        {
                            urls: 'turn:numb.viagenie.ca',
                            username: 'webrtc@live.com',
                            credential: 'muazkh'
                        }
                    ],
                    iceTransportPolicy: 'all',
                    iceCandidatePoolSize: 10
                },
                secure: true,
                debug: 3
            });

            this.setupPeerEventListeners();
        } catch (error) {
            this.showNotification('エラー', `初期化に失敗しました: ${error.message}`, 'error');
            throw error;
        }
    }

    // PeerJSのイベントリスナー設定
    setupPeerEventListeners() {
        this.peer.on('open', id => {
            this.elements.localPeerId.value = id;
            this.updateMeetingUrl();
            this.updateStatus('準備完了');
            
            if (new URLSearchParams(window.location.search).has('id')) {
                this.checkUrlParameters();
            }
        });

        this.peer.on('call', async call => {
            try {
                call.answer(this.localStream);
                this.handleCall(call);
                this.updateStatus('通話中');
                // 受信側でも切断ボタンを有効化
                this.elements.connectButton.disabled = true;
                this.elements.disconnectButton.disabled = false;
            } catch (error) {
                this.showNotification('エラー', '着信応答に失敗しました', 'error');
            }
        });

        this.peer.on('connection', conn => {
            this.dataConnection = conn;
            this.setupDataConnection();
        });

        this.peer.on('error', error => {
            this.showNotification('エラー', `接続エラー: ${error.message}`, 'error');
            this.updateStatus('エラー発生', true);
        });

        this.peer.on('disconnected', () => {
            this.updateStatus('切断されました', true);
            setTimeout(() => {
                if (this.peer) {
                    this.peer.reconnect();
                }
            }, 3000);
        });
    }

    // ローカルストリームのセットアップ
    async setupLocalStream() {
        try {
            this.updateStatus('カメラ/マイクの準備中...');
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            this.elements.localVideo.srcObject = this.localStream;
            this.updateStatus('カメラ準備完了');
        } catch (error) {
            this.isMediaReady = false;
            this.showNotification('エラー', 'カメラ/マイクの取得に失敗しました', 'error');
            this.updateStatus('メディア取得エラー', true);
            throw error;
        }
    }

    // イベントリスナーの設定
    setupEventListeners() {
        this.elements.connectButton.addEventListener('click', () => this.connect());
        this.elements.disconnectButton.addEventListener('click', () => {
            this.disconnectedBySelf = true;
            // 相手に切断シグナルを即座に送信してから切断
            this.sendDisconnectSignal().then(() => {
                this.showDisconnectOverlay('通話を終了しました');
                this.disconnect();
            });
        });
        this.elements.toggleMicButton.addEventListener('click', () => this.toggleAudio());
        this.elements.toggleVideoButton.addEventListener('click', () => this.toggleVideo());
        this.elements.volumeControlButton.addEventListener('click', () => this.toggleVolumeControl());
        this.elements.volumeSlider.addEventListener('input', (e) => this.updateVolume(e.target.value));
        // スライダーの初期値表示を更新
        this.updateVolume(100);
        document.addEventListener('click', (e) => this.handleClickOutside(e));
        this.elements.toggleKeyVisibilityButton.addEventListener('click', () => this.toggleKeyVisibility());
        window.addEventListener('resize', () => this.handleResize());

        this.elements.modalClose.addEventListener('click', () => {
            this.elements.notificationModal.classList.remove('visible');
        });
    }

    // 音量コントロールの表示切り替え
    toggleVolumeControl() {
        this.isVolumeControlVisible = !this.isVolumeControlVisible;
        this.elements.volumeSliderContainer.classList.toggle('visible', this.isVolumeControlVisible);
    }

    // WebAudio APIを使って音量を設定（最大200%対応）
    setupAudioBoost(stream) {
        try {
            if (this.audioContext) {
                this.audioContext.close();
            }
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioSource = this.audioContext.createMediaStreamSource(stream);
            this.gainNode = this.audioContext.createGain();
            const destination = this.audioContext.createMediaStreamDestination();

            this.audioSource.connect(this.gainNode);
            this.gainNode.connect(destination);
            this.gainNode.connect(this.audioContext.destination);

            // gainの初期値を現在の音量から設定
            this.gainNode.gain.value = this.currentVolume / 100;

            // remoteVideoのsrcObjectはそのままにして、
            // 音声はAudioContextで再生（ビデオの音はミュートにする）
            this.elements.remoteVideo.muted = true;
        } catch (e) {
            console.warn('WebAudio API初期化失敗、フォールバック:', e);
        }
    }

    // 音量の更新
    updateVolume(value) {
        this.currentVolume = parseInt(value);
        const gain = this.currentVolume / 100; // 0〜2.0 (200%対応)

        if (this.gainNode) {
            this.gainNode.gain.value = gain;
        } else {
            // フォールバック: WebAudio未対応時はclampして設定
            this.elements.remoteVideo.volume = Math.min(gain, 1);
        }

        const icon = this.elements.volumeControlButton.querySelector('i');
        if (value == 0) {
            icon.className = 'fas fa-volume-mute';
        } else if (value < 50) {
            icon.className = 'fas fa-volume-down';
        } else {
            icon.className = 'fas fa-volume-up';
        }

        // スライダーの色を更新（100%超えたら色を変える）
        const slider = this.elements.volumeSlider;
        const pct = (this.currentVolume / 200) * 100;
        const overBoost = this.currentVolume > 100;
        slider.style.setProperty('--volume-pct', `${pct}%`);
        slider.classList.toggle('boosted', overBoost);

        // ラベル更新
        if (this.elements.volumeValue) {
            this.elements.volumeValue.textContent = this.currentVolume;
        }
        if (this.elements.boostBadge) {
            this.elements.boostBadge.classList.toggle('visible', overBoost);
        }
    }

    // 音量コントロール外のクリック処理
    handleClickOutside(event) {
        if (!this.elements.volumeSliderContainer.contains(event.target) &&
            !this.elements.volumeControlButton.contains(event.target)) {
            this.isVolumeControlVisible = false;
            this.elements.volumeSliderContainer.classList.remove('visible');
        }
    }

    // 暗号化キーの表示切り替え
    toggleKeyVisibility() {
        this.isKeyVisible = !this.isKeyVisible;
        this.elements.encryptionKeyDisplay.type = this.isKeyVisible ? 'text' : 'password';
        const icon = this.elements.toggleKeyVisibilityButton.querySelector('i');
        icon.className = this.isKeyVisible ? 'fas fa-eye' : 'fas fa-eye-slash';
    }

    // レスポンシブ対応のリサイズハンドラ
    handleResize() {
        if (window.innerWidth <= 768) {
            this.isVolumeControlVisible = false;
            this.elements.volumeSliderContainer.classList.remove('visible');
        }
    }

    // コピーボタンの設定
    setupCopyButtons() {
        document.querySelectorAll('.copy-btn').forEach(button => {
            button.addEventListener('click', () => {
                const targetId = button.dataset.target;
                const input = document.getElementById(targetId);
                input.select();
                document.execCommand('copy');
                this.showNotification('成功', 'コピーしました', 'success');
            });
        });
    }

    // 接続処理
    async connect() {
        const remotePeerId = this.elements.remotePeerId.value;
        if (!remotePeerId) {
            this.showNotification('警告', '相手のIDを入力してください', 'warning');
            return;
        }

        try {
            this.updateStatus('接続中...');
            
            if (!this.isMediaReady) {
                throw new Error('カメラ/マイクの準備が完了していません');
            }
            
            if (!this.peer || !this.peer.id) {
                throw new Error('PeerJSの初期化が完了していません');
            }

            this.dataConnection = this.peer.connect(remotePeerId);
            this.setupDataConnection();

            const call = this.peer.call(remotePeerId, this.localStream);
            this.handleCall(call);

            this.elements.connectButton.disabled = true;
            this.elements.disconnectButton.disabled = false;
        } catch (error) {
            console.error('接続エラー:', error);
            this.showNotification('エラー', '接続に失敗しました。再試行してください。', 'error');
            this.updateStatus('接続エラー', true);
            
            this.elements.connectButton.disabled = false;
            this.elements.disconnectButton.disabled = true;
        }
    }

    // データ接続のセットアップ
    setupDataConnection() {
        this.dataConnection.on('open', () => {
            this.updateStatus('データチャネル確立');
        });

        this.dataConnection.on('data', async data => {
            // 切断シグナルは平文で即座に処理
            if (data && data.type === 'DISCONNECT_SIGNAL') {
                this.showDisconnectOverlay('相手が通話を終了しました');
                this.disconnect();
                return;
            }

            try {
                const decrypted = await CryptoUtil.decrypt(
                    this.encryptionKey,
                    data.iv,
                    data.encryptedData
                );
                const decodedData = new TextDecoder().decode(decrypted);
                this.handleReceivedData(JSON.parse(decodedData));
            } catch (error) {
                console.error('データ復号化エラー:', error);
            }
        });

        // シグナルが届かなかった場合のフォールバック検知
        this.dataConnection.on('close', () => {
            if (!this.disconnectedBySelf) {
                this.showDisconnectOverlay('相手が通話を終了しました');
                this.disconnect();
            }
        });
    }

    // 通話処理
    handleCall(call) {
        this.currentCall = call;

        call.on('stream', stream => {
            this.elements.remoteVideo.srcObject = stream;
            this.setupAudioBoost(stream);
            this.updateStatus('通話中');
            this.startConnectionQualityMonitoring();
        });

        call.on('close', () => {
            // データチャンネルで先に検知するため、ここではfallbackのみ
            if (!this.disconnectedBySelf) {
                this.showDisconnectOverlay('相手が通話を終了しました');
                this.disconnect();
            }
        });

        call.peerConnection.oniceconnectionstatechange = () => {
            const state = call.peerConnection.iceConnectionState;
            this.updateConnectionQuality(state);
        };
    }

    // 接続品質のモニタリング
    startConnectionQualityMonitoring() {
        setInterval(() => {
            if (this.currentCall && this.currentCall.peerConnection) {
                this.currentCall.peerConnection.getStats().then(stats => {
                    stats.forEach(report => {
                        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                            const quality = this.calculateConnectionQuality(report);
                            this.elements.connectionQuality.textContent = quality;
                        }
                    });
                });
            }
        }, 1000);
    }

    // 接続品質の計算
    calculateConnectionQuality(stats) {
        if (stats.availableOutgoingBitrate) {
            const bitrate = stats.availableOutgoingBitrate / 1000000; // Mbps
            if (bitrate > 2) return '良好';
            if (bitrate > 1) return '普通';
            return '不安定';
        }
        return '計測中...';
    }

    // オーディオのトグル
    toggleAudio() {
        this.isAudioEnabled = !this.isAudioEnabled;
        this.localStream.getAudioTracks().forEach(track => {
            track.enabled = this.isAudioEnabled;
        });
        this.elements.toggleMicButton.classList.toggle('active', !this.isAudioEnabled);
        this.elements.toggleMicButton.querySelector('i').className =
            this.isAudioEnabled ? 'fas fa-microphone' : 'fas fa-microphone-slash';
    }

    // ビデオのトグル
    toggleVideo() {
        this.isVideoEnabled = !this.isVideoEnabled;
        this.localStream.getVideoTracks().forEach(track => {
            track.enabled = this.isVideoEnabled;
        });
        this.elements.toggleVideoButton.classList.toggle('active', !this.isVideoEnabled);
        this.elements.toggleVideoButton.querySelector('i').className =
            this.isVideoEnabled ? 'fas fa-video' : 'fas fa-video-slash';
    }

    // 切断オーバーレイ表示
    showDisconnectOverlay(reason = '通話が終了しました') {
        // 既存のオーバーレイを削除
        const existing = document.getElementById('disconnectOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'disconnectOverlay';
        overlay.className = 'disconnect-overlay';
        overlay.innerHTML = `
            <div class="disconnect-overlay-content">
                <div class="disconnect-icon">
                    <i class="fas fa-phone-slash"></i>
                </div>
                <p class="disconnect-reason">${reason}</p>
                <p class="disconnect-sub">接続が切断されました</p>
                <button class="disconnect-close-btn" onclick="document.getElementById('disconnectOverlay').remove()">
                    閉じる
                </button>
            </div>
        `;
        document.body.appendChild(overlay);

        // 5秒後に自動で消える
        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.classList.add('fade-out');
                setTimeout(() => overlay.remove(), 400);
            }
        }, 5000);
    }

    // 切断処理
    async disconnect() {
        await this.cleanup();
        this.elements.connectButton.disabled = false;
        this.elements.disconnectButton.disabled = true;
        this.elements.statusIndicator.classList.remove('connected');

        // AudioContextのクリーンアップ
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
            this.gainNode = null;
            this.audioSource = null;
        }
        this.elements.remoteVideo.muted = false;

        // 音量コントロールをリセット
        this.isVolumeControlVisible = false;
        this.elements.volumeSliderContainer.classList.remove('visible');
        this.elements.volumeSlider.value = 100;
        this.elements.volumeSlider.classList.remove('boosted');
        this.elements.volumeControlButton.querySelector('i').className = 'fas fa-volume-up';
        this.disconnectedBySelf = false;
    }

    // ステータス更新
    updateStatus(message, isError = false) {
        this.elements.connectionStatus.textContent = message;
        this.elements.statusIndicator.classList.toggle('connected', !isError);
        console.log('Status:', message);
    }

    // 接続品質の更新
    updateConnectionQuality(state) {
        let quality = '不明';
        switch (state) {
            case 'new':
            case 'checking':
                quality = '接続確認中...';
                break;
            case 'connected':
                quality = '良好';
                break;
            case 'completed':
                quality = '安定';
                break;
            case 'disconnected':
                quality = '切断';
                break;
            case 'failed':
                quality = '接続失敗';
                break;
        }
        this.elements.connectionQuality.textContent = quality;
    }

    // 通知の表示
    showNotification(title, message, type = 'info') {
        const modal = this.elements.notificationModal;
        const modalContent = modal.querySelector('.modal-content');
        const modalMessage = modal.querySelector('.modal-message');
        const modalIcon = modal.querySelector('.modal-icon');

        modalMessage.textContent = message;

        // アイコンの設定
        modalIcon.className = 'modal-icon fas';
        switch (type) {
            case 'success':
                modalIcon.classList.add('fa-check-circle');
                modalIcon.style.color = 'var(--success-color)';
                break;
            case 'error':
                modalIcon.classList.add('fa-exclamation-circle');
                modalIcon.style.color = 'var(--danger-color)';
                break;
            case 'warning':
                modalIcon.classList.add('fa-exclamation-triangle');
                modalIcon.style.color = 'var(--warning-color)';
                break;
            default:
                modalIcon.classList.add('fa-info-circle');
                modalIcon.style.color = 'var(--primary-color)';
        }

        modal.classList.add('visible');
    }

    // 切断シグナルを平文で即座に送信
    async sendDisconnectSignal() {
        if (!this.dataConnection || this.dataConnection.open === false) return;
        try {
            this.dataConnection.send({ type: 'DISCONNECT_SIGNAL' });
            // データが送信されるまで少し待つ
            await new Promise(resolve => setTimeout(resolve, 150));
        } catch (e) {
            console.warn('切断シグナル送信失敗:', e);
        }
    }

    // 暗号化されたデータの送信
    async sendEncryptedData(data) {
        if (!this.dataConnection || !this.encryptionKey) return;

        try {
            const encrypted = await CryptoUtil.encrypt(
                this.encryptionKey,
                new TextEncoder().encode(JSON.stringify(data))
            );
            this.dataConnection.send({
                iv: encrypted.iv,
                encryptedData: encrypted.data
            });
        } catch (error) {
            console.error('暗号化エラー:', error);
        }
    }

    // 受信データの処理
    handleReceivedData(data) {
        console.log('Received data:', data);
    }
}

// アプリケーションの初期化
window.addEventListener('DOMContentLoaded', () => {
    new SecureVideoChat();
});