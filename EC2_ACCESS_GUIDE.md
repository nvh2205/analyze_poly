# Hướng Dẫn Truy Cập EC2

## 📋 Yêu Cầu

1. File private key (`.pem` file) - thường có tên như `my-key.pem`, `ec2-key.pem`, etc.
2. Public IP hoặc DNS của EC2 instance
3. Username (thường là `ec2-user` cho Amazon Linux, `ubuntu` cho Ubuntu)

## 🔐 Bước 1: Bảo Mật File Private Key

```bash
# Đặt quyền chỉ đọc cho chủ sở hữu (bắt buộc)
chmod 400 /path/to/your-key.pem
```

**Lưu ý quan trọng:**
- File `.pem` phải có quyền `400` (chỉ owner đọc được)
- Nếu không đặt quyền đúng, SSH sẽ từ chối kết nối

## 🚀 Bước 2: Kết Nối EC2

### Cách 1: Sử dụng SSH trực tiếp

```bash
# Cú pháp cơ bản
ssh -i /path/to/your-key.pem username@ec2-ip-or-dns

# Ví dụ với Amazon Linux
ssh -i ~/Downloads/my-key.pem ec2-user@54.123.45.67

# Ví dụ với Ubuntu
ssh -i ~/Downloads/my-key.pem ubuntu@ec2-123-45-67-89.compute-1.amazonaws.com
```

### Cách 2: Sử dụng script helper (khuyến nghị)

Tạo file `connect-ec2.sh` và chạy:

```bash
./connect-ec2.sh
```

## 📝 Bước 3: Xác Định Username

Username phụ thuộc vào AMI (Amazon Machine Image) bạn sử dụng:

| AMI Type | Username |
|----------|----------|
| Amazon Linux 2023 | `ec2-user` |
| Amazon Linux 2 | `ec2-user` |
| Ubuntu | `ubuntu` |
| Debian | `admin` |
| RHEL | `ec2-user` hoặc `root` |
| CentOS | `centos` |
| SUSE | `ec2-user` |

## 🔍 Tìm Thông Tin EC2 Instance

### Từ AWS Console:
1. Vào **EC2 Dashboard**
2. Chọn **Instances**
3. Tìm instance của bạn
4. Xem **Public IPv4 address** hoặc **Public IPv4 DNS**

### Từ AWS CLI:
```bash
# Liệt kê tất cả instances
aws ec2 describe-instances --query 'Reservations[*].Instances[*].[InstanceId,PublicIpAddress,State.Name,Tags[?Key==`Name`].Value|[0]]' --output table

# Lấy IP của instance cụ thể
aws ec2 describe-instances --instance-ids i-1234567890abcdef0 --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
```

## 🛠️ Cấu Hình SSH Config (Tùy chọn)

Để không phải nhập lại mỗi lần, thêm vào `~/.ssh/config`:

```bash
# Mở file config
nano ~/.ssh/config

# Thêm cấu hình (ví dụ)
Host my-ec2
    HostName 54.123.45.67
    User ec2-user
    IdentityFile ~/Downloads/my-key.pem
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

Sau đó chỉ cần chạy:
```bash
ssh my-ec2
```

## 🚨 Xử Lý Lỗi Thường Gặp

### Lỗi: "Permission denied (publickey)"
```bash
# Kiểm tra quyền file
ls -l /path/to/your-key.pem
# Phải hiển thị: -r-------- (400)

# Sửa quyền nếu cần
chmod 400 /path/to/your-key.pem
```

### Lỗi: "WARNING: UNPROTECTED PRIVATE KEY FILE!"
```bash
# File key phải chỉ có owner đọc được
chmod 400 /path/to/your-key.pem
```

### Lỗi: "Connection timed out"
- Kiểm tra Security Group có cho phép SSH (port 22) từ IP của bạn không
- Kiểm tra instance có đang chạy không
- Kiểm tra Public IP có đúng không

### Lỗi: "Host key verification failed"
```bash
# Xóa key cũ khỏi known_hosts
ssh-keygen -R ec2-ip-or-dns
```

## 📦 Sau Khi Kết Nối Thành Công

### 1. Cập nhật hệ thống
```bash
# Amazon Linux
sudo yum update -y

# Ubuntu
sudo apt update && sudo apt upgrade -y
```

### 2. Cài đặt Docker (nếu chưa có)
```bash
# Amazon Linux
sudo yum install docker -y
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user

# Ubuntu
sudo apt install docker.io -y
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ubuntu
```

### 3. Cài đặt Docker Compose
```bash
# Tải Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose

# Cấp quyền thực thi
sudo chmod +x /usr/local/bin/docker-compose

# Kiểm tra
docker-compose --version
```

### 4. Clone repository (nếu chưa có)
```bash
# Cài Git nếu chưa có
sudo yum install git -y  # Amazon Linux
# hoặc
sudo apt install git -y  # Ubuntu

# Clone repo
git clone <your-repo-url> strategy_trade_poly
cd strategy_trade_poly
```

## 🔄 Chạy Deployment

Sau khi kết nối và setup xong:

```bash
cd /path/to/strategy_trade_poly
./deploy.sh
```

## 💡 Tips

1. **Sử dụng Screen hoặc Tmux** để giữ session khi disconnect:
```bash
# Cài screen
sudo yum install screen -y  # hoặc sudo apt install screen -y

# Tạo session mới
screen -S deploy

# Detach: Ctrl+A, sau đó D
# Reattach: screen -r deploy
```

2. **Copy file từ local lên EC2:**
```bash
scp -i /path/to/key.pem file.txt ec2-user@ec2-ip:/home/ec2-user/
```

3. **Copy file từ EC2 về local:**
```bash
scp -i /path/to/key.pem ec2-user@ec2-ip:/path/to/file.txt ./
```

4. **Tạo alias trong shell:**
```bash
# Thêm vào ~/.bashrc hoặc ~/.zshrc
alias ec2-connect='ssh -i ~/path/to/key.pem ec2-user@your-ec2-ip'
```

