const test = require('node:test')
const assert = require('node:assert/strict')
const { splitMarkdown, splitEnglishSentences, MAX_UNITS } = require('./textSentences.cjs')

const en = (text, opts) => splitMarkdown(text, opts).units.map(u => u.en)

test('段落按句子切分，硬换行先并成一句', () => {
  assert.deepEqual(
    en('U-Net has an encoder and a decoder. It is popular.\nIt wins benchmarks.'),
    ['U-Net has an encoder and a decoder.', 'It is popular.', 'It wins benchmarks.'],
  )
})

test('缩写 / 小数 / 版本号 / 首字母不切句', () => {
  assert.deepEqual(en('We use SAM, UMAP, etc. in the pipeline. Then we ship it.'), [
    'We use SAM, UMAP, etc. in the pipeline.', 'Then we ship it.',
  ])
  assert.deepEqual(en('Accuracy is 0.92 on v1.2. That is good.'), ['Accuracy is 0.92 on v1.2.', 'That is good.'])
  assert.deepEqual(en('e.g. this and i.e. that.'), ['e.g. this and i.e. that.'])
  assert.deepEqual(en('U.S. policy matters. Yes.'), ['U.S. policy matters.', 'Yes.'])
  assert.deepEqual(en('J. Smith wrote it. Done.'), ['J. Smith wrote it.', 'Done.'])
})

test('行内代码里的点号不切句，代码标识符原样保留', () => {
  assert.deepEqual(en('Call `model.fit()` twice. Then stop.'), ['Call model.fit() twice.', 'Then stop.'])
  assert.deepEqual(en('Use `top_k` and `getUserById` here. Ok.'), ['Use top_k and getUserById here.', 'Ok.'])
})

test('围栏代码块整块丢弃，标题只作为 section', () => {
  const text = '# U-Net\n\nIt is a CNN. PaCMAP is a manifold method.\n\n```js\nconst a = 1. Not a sentence.\n```\n\n## Results\n\nmIoU is 0.81.'
  const { units } = splitMarkdown(text)
  assert.deepEqual(units, [
    { en: 'It is a CNN.', section: 'U-Net' },
    { en: 'PaCMAP is a manifold method.', section: 'U-Net' },
    { en: 'mIoU is 0.81.', section: 'Results' },
  ])
})

test('列表项逐条成句，去掉标记与编号', () => {
  assert.deepEqual(en('- Install the package.\n- Run the script.'), ['Install the package.', 'Run the script.'])
  assert.deepEqual(en('1. Open the file. 2. Save it.'), ['Open the file.', 'Save it.'])
})

test('表格每行按单元格成句，分隔行丢弃', () => {
  const table = '| Method | Dataset |\n| --- | :---: |\n| SAM | COCO |'
  assert.deepEqual(en(table), ['Method', 'Dataset', 'SAM', 'COCO'])
})

test('链接 / 图片 / 强调语法被剥掉但文本与术语保留', () => {
  assert.deepEqual(en('**[U-Net](https://example.com)** is fast.'), ['U-Net is fast.'])
  assert.deepEqual(en('![figure](a.png) The architecture is simple.'), ['The architecture is simple.'])
  assert.deepEqual(en('> quoted advice here.'), ['quoted advice here.'])
})

test('无英文 / 空输入 → 0 句', () => {
  assert.deepEqual(splitMarkdown('这是一段中文。'), { units: [], truncated: false })
  assert.deepEqual(splitMarkdown(''), { units: [], truncated: false })
  assert.deepEqual(splitMarkdown(null), { units: [], truncated: false })
  assert.deepEqual(splitMarkdown('```py\nprint(1)\n```'), { units: [], truncated: false })
})

test('超长句按 maxChars 就近切开', () => {
  const long = Array.from({ length: 40 }, (_, i) => `part${i} is quite descriptive`).join(', ') + '.'
  const { units } = splitMarkdown(long, { maxChars: 120 })
  assert.ok(units.length > 1)
  for (const u of units) assert.ok(u.en.length <= 120, `${u.en.length} > 120: ${u.en}`)
})

test('超过 maxUnits 时截断并置 truncated', () => {
  const many = Array.from({ length: MAX_UNITS + 5 }, (_, i) => `Sentence number ${i} here.`).join(' ')
  const { units, truncated } = splitMarkdown(many)
  assert.equal(units.length, MAX_UNITS)
  assert.equal(truncated, true)
  assert.deepEqual(splitMarkdown('One sentence.'), { units: [{ en: 'One sentence.', section: '' }], truncated: false })
})

test('splitEnglishSentences 对空值安全', () => {
  assert.deepEqual(splitEnglishSentences(''), [])
  assert.deepEqual(splitEnglishSentences('   '), [])
})

test('代码标识符与指数不被强调语法吞掉', () => {
  assert.deepEqual(en('Use __init__ and x**2 in the code. Ok.'), ['Use __init__ and x**2 in the code.', 'Ok.'])
  assert.deepEqual(en('Use **bold words** here. Ok.'), ['Use bold words here.', 'Ok.'])
  assert.deepEqual(en('a * b and *it* stay. Ok.'), ['a * b and it stay.', 'Ok.'])
})

test('波浪线围栏代码块同样整块丢弃', () => {
  const text = '~~~js\nconst a = 1. Never practiced.\n~~~\n\nA real sentence here.'
  assert.deepEqual(en(text), ['A real sentence here.'])
})

test('表格行切单元格时不在行内代码里切竖线', () => {
  const table = '| `a|b` | x |\n| --- | --- |\n| SAM | COCO |'
  const units = en(table)
  assert.ok(units.includes('a|b'), `实际：${JSON.stringify(units)}`)
  assert.ok(units.includes('SAM'))
})
