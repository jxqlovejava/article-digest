import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { heuristicClassify } from './knowledge-classifier';

describe('heuristicClassify fallback', () => {
  before(() => {
    // Ensure LLM is disabled for heuristic tests
    process.env.LLM_API_KEY = '';
  });

  it('classifies procedure-style text as procedure', () => {
    const text = `本文介绍如何使用 Docker 部署 Node.js 应用。首先，你需要安装 Docker。
然后，创建一个 Dockerfile，配置 Node.js 环境。接下来，运行 docker build 构建镜像。
最后，使用 docker run 启动容器。以下是具体步骤：第一步，安装 Docker Desktop；
第二步，编写 Dockerfile；第三步，构建镜像。`;

    const result = heuristicClassify(text);
    assert.strictEqual(result, 'procedure', 'Text with 步骤/首先/然后 should be procedure');
  });

  it('classifies concept-style text as concept', () => {
    const text = `本文探讨了认知心理学中的关键理论框架。核心概念包括工作记忆模型、
双重编码理论和认知负荷理论。这些理论框架为我们理解人类学习机制提供了重要的
思想体系和方法论基础。理解这些抽象概念对于设计有效的教学方案至关重要。`;

    const result = heuristicClassify(text);
    assert.strictEqual(result, 'concept', 'Text with 理论/概念/框架 should be concept');
  });

  it('classifies design-style text as design', () => {
    const text = `系统架构设计中，我们需要权衡微服务和单体架构的利弊。微服务架构
将系统拆分为独立部署的服务单元，每个服务负责特定的业务能力。相比传统的单体架构，
微服务在可扩展性和团队自治方面具有明显优势，但也带来了分布式系统的复杂性。
架构决策需要考虑团队规模、业务复杂度和运维能力等因素。`;

    const result = heuristicClassify(text);
    assert.strictEqual(result, 'design', 'Text with 设计/架构/决策 should be design');
  });

  it('classifies plain factual text as memory', () => {
    const text = '昨天下午三点，张三在北京朝阳区参加了年度总结会议。参会人数共有四十二人。会议持续了两个小时。';

    const result = heuristicClassify(text);
    assert.strictEqual(result, 'memory', 'Plain factual text should be memory');
  });

  it('classifies text with code blocks as procedure', () => {
    const text = `下面是一个简单的 React 组件：

\`\`\`tsx
function Hello() {
  return <div>Hello World</div>;
}
\`\`\`

这个组件渲染一个包含文本的 div 元素。`;

    const result = heuristicClassify(text);
    assert.strictEqual(result, 'procedure', 'Text with code blocks should be procedure');
  });
});
