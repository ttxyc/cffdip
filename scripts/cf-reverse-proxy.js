// scripts/cf-reverse-proxy.js
// Cloudflare 反代 IP 自动测速脚本

const fs = require('fs');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// 配置
const CONFIG = {
    testUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
    timeout: 3000,
    concurrency: 15,
    topCount: 10,
    testRounds: 2
};

// ============ 工具函数 ============
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchUrl(url, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.get(url, { timeout }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

// 获取 Cloudflare 官方 IP 段
async function getCloudflareRanges() {
    const ranges = [];
    try {
        const content = await fetchUrl('https://www.cloudflare.com/ips-v4', 5000);
        const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'));
        ranges.push(...lines);
        console.log(`✅ 获取到 ${lines.length} 个官方 IP 段`);
    } catch (error) {
        console.log(`⚠️ 获取官方 IP 段失败: ${error.message}`);
    }
    return ranges;
}

// 常用优质反代 IP（硬编码）
const KNOWN_IPS = [
    '104.17.220.48', '104.17.109.223', '198.41.209.134',
    '104.16.153.84', '104.17.114.21', '104.19.156.231',
    '104.17.178.42', '104.17.160.232', '104.21.96.1',
    '172.67.128.1', '188.114.96.1', '162.159.128.1',
    '104.20.0.1', '104.22.0.1', '104.24.0.1',
    '104.26.0.1', '104.28.0.1', '104.30.0.1'
];

// CIDR 转 IP（采样）
function cidrToSample(cidr, sampleCount = 2) {
    const ips = [];
    try {
        const [base, prefix] = cidr.split('/');
        const parts = base.split('.').map(Number);
        const hostBits = 32 - parseInt(prefix);
        const totalHosts = Math.pow(2, hostBits);
        
        if (totalHosts > 256) {
            // 大段，只取前几个
            for (let i = 1; i <= Math.min(sampleCount, totalHosts - 1); i++) {
                const offset = Math.floor(totalHosts / (sampleCount + 1)) * i;
                let remaining = offset;
                let ipParts = [...parts];
                for (let j = 3; j >= 0 && remaining > 0; j--) {
                    const add = remaining % 256;
                    ipParts[j] = (ipParts[j] + add) % 256;
                    remaining = Math.floor(remaining / 256);
                }
                ips.push(ipParts.join('.'));
            }
        }
    } catch (e) {
        // 忽略解析错误
    }
    return ips;
}

// 测试单个 IP
async function testIp(ip, testUrl) {
    const start = Date.now();
    const urlObj = new URL(testUrl);
    const testUrlWithIp = `${urlObj.protocol}//${ip}${urlObj.pathname}`;
    
    return new Promise((resolve) => {
        const protocol = urlObj.protocol === 'https:' ? https : http;
        const req = protocol.get(testUrlWithIp, {
            timeout: CONFIG.timeout,
            headers: { Host: urlObj.host }
        }, (res) => {
            const latency = Date.now() - start;
            res.resume();
            resolve({ ip, latency, success: true });
        });
        
        req.on('error', () => resolve({ ip, latency: null, success: false }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ ip, latency: null, success: false });
        });
    });
}

// 综合测试
async function testIpQuality(ip, testUrl) {
    let totalLatency = 0;
    let successCount = 0;
    
    for (let i = 0; i < CONFIG.testRounds; i++) {
        const result = await testIp(ip, testUrl);
        if (result.success) {
            totalLatency += result.latency;
            successCount++;
        }
        await sleep(100);
    }
    
    if (successCount === 0) return null;
    return {
        ip,
        latency: Math.round(totalLatency / successCount),
        success: true
    };
}

// 批量测试
async function batchTest(ips, testUrl) {
    const results = [];
    console.log(`\n🚀 开始测试 ${ips.length} 个 IP...`);
    console.log(`   测试目标: ${testUrl}\n`);
    
    for (let i = 0; i < ips.length; i += CONFIG.concurrency) {
        const batch = ips.slice(i, i + CONFIG.concurrency);
        const batchPromises = batch.map(ip => testIpQuality(ip, testUrl));
        const batchResults = await Promise.all(batchPromises);
        
        for (const result of batchResults) {
            if (result) {
                results.push(result);
                console.log(`✅ ${result.ip.padEnd(16)} - ${result.latency}ms`);
            }
        }
        console.log(`   进度: ${Math.min(i + CONFIG.concurrency, ips.length)}/${ips.length}\n`);
        await sleep(500);
    }
    
    results.sort((a, b) => a.latency - b.latency);
    return results;
}

// 生成多种格式的输出
function generateOutputs(results, topCount, timestamp) {
    const topIps = results.slice(0, topCount);
    
    // 1. TXT 格式（纯 IP 列表，带注释）
    const txtContent = [
        `# Cloudflare 反代 IP 列表`,
        `# 更新时间: ${timestamp}`,
        `# 测试目标: ${CONFIG.testUrl}`,
        `# 可用 IP 数: ${results.length}`,
        `# 最快 IP: ${topIps[0]?.ip || '无'} (${topIps[0]?.latency || 0}ms)`,
        ``,
        ...topIps.map(item => `${item.ip.padEnd(16)} # ${item.latency}ms`)
    ].join('\n');
    
    // 2. 纯 IP 列表（无注释，方便脚本使用）
    const pureIps = topIps.map(item => item.ip).join('\n');
    
    // 3. JSON 格式
    const jsonContent = {
        timestamp,
        testUrl: CONFIG.testUrl,
        totalAvailable: results.length,
        fastestIps: topIps,
        allIps: results
    };
    
    // 4. Markdown 格式（适合 GitHub Pages）
    const mdContent = [
        `# Cloudflare 反代 IP 列表`,
        ``,
        `> 更新时间: ${new Date(timestamp).toLocaleString()}`,
        ``,
        `## 🏆 最快的 ${topCount} 个 IP`,
        ``,
        `| 排名 | IP 地址 | 延迟 |`,
        `|------|---------|------|`,
        ...topIps.map((item, idx) => `| ${idx + 1} | \`${item.ip}\` | ${item.latency}ms |`),
        ``,
        `## 📊 测试说明`,
        ``,
        `- 测试目标: ${CONFIG.testUrl}`,
        `- 超时时间: ${CONFIG.timeout}ms`,
        `- 总测试 IP 数: ${results.length}`,
        `- 更新时间: ${timestamp}`,
        ``,
        `## 📝 使用方法`,
        ``,
        `\`\`\`bash`,
        `# 获取纯 IP 列表`,
        `curl -s https://raw.githubusercontent.com/[你的用户名]/[仓库名]/main/cf-ips-pure.txt`,
        ``,
        `# 获取带注释的列表`,
        `curl -s https://raw.githubusercontent.com/[你的用户名]/[仓库名]/main/cf-ips.txt`,
        `\`\`\``
    ].join('\n');
    
    // 写入文件
    fs.writeFileSync('cf-ips.txt', txtContent);
    fs.writeFileSync('cf-ips-pure.txt', pureIps);
    fs.writeFileSync('cf-ips.json', JSON.stringify(jsonContent, null, 2));
    fs.writeFileSync('cf-ips.md', mdContent);
    
    console.log(`\n💾 已保存结果:`);
    console.log(`   - cf-ips.txt (带注释)`);
    console.log(`   - cf-ips-pure.txt (纯 IP)`);
    console.log(`   - cf-ips.json (JSON)`);
    console.log(`   - cf-ips.md (Markdown)`);
}

// ============ 主函数 ============
async function main() {
    console.log('🌍 Cloudflare 反代 IP 自动获取工具');
    console.log('='.repeat(50));
    
    try {
        // 1. 获取 IP 列表
        console.log('\n📡 获取 Cloudflare IP 段...');
        const ranges = await getCloudflareRanges();
        
        const ipSet = new Set();
        
        // 2. 展开 CIDR 段
        console.log(`🔨 展开 IP 段...`);
        for (const range of ranges.slice(0, 30)) {
            const sampledIps = cidrToSample(range, 2);
            sampledIps.forEach(ip => ipSet.add(ip));
        }
        
        // 3. 添加已知 IP
        KNOWN_IPS.forEach(ip => ipSet.add(ip));
        
        const ipList = Array.from(ipSet);
        console.log(`✅ 共生成 ${ipList.length} 个待测试 IP`);
        
        // 4. 测试 IP
        const results = await batchTest(ipList, CONFIG.testUrl);
        
        if (results.length === 0) {
            console.error('❌ 没有找到可用的 IP');
            process.exit(1);
        }
        
        // 5. 输出结果
        const timestamp = new Date().toISOString();
        generateOutputs(results, CONFIG.topCount, timestamp);
        
        // 6. 打印最快的几个
        console.log('\n🏆 最快的 IP 列表:');
        console.log('='.repeat(50));
        results.slice(0, CONFIG.topCount).forEach((item, idx) => {
            console.log(`${(idx + 1).toString().padStart(2)}. ${item.ip.padEnd(16)} - ${item.latency}ms`);
        });
        
    } catch (error) {
        console.error('❌ 程序出错:', error);
        process.exit(1);
    }
}

// 运行
main();
