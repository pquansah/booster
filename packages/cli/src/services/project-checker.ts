import { readFileSync, existsSync, removeSync } from 'fs-extra'
import * as path from 'path'
import { projectDir, ProjectInitializerConfig } from './project-initializer'
import Brand from '../common/brand'
import { filePath, getResourceType } from './generator'
import { classNameToFileName } from '../common/filenames'
import Prompter from './user-prompt'
import { oraLogger } from './logger'

function checkIndexFileIsBooster(indexFilePath: string): void {
  const contents = readFileSync(indexFilePath)
  if (!contents.includes('Booster.start(')) {
    throw new Error(
      'The main application file does not start a Booster application. Verify you are in the right project'
    )
  }
}

export async function checkCurrentDirIsABoosterProject(): Promise<void> {
  return checkItIsABoosterProject(process.cwd())
}

export async function checkItIsABoosterProject(projectPath: string): Promise<void> {
  const projectAbsolutePath = path.resolve(projectPath)
  try {
    const tsConfigJsonContents = require(path.join(projectAbsolutePath, 'tsconfig.json'))
    const indexFilePath = path.normalize(
      path.join(projectAbsolutePath, tsConfigJsonContents.compilerOptions.rootDir, 'index.ts')
    )
    checkIndexFileIsBooster(indexFilePath)
  } catch (e) {
    throw new Error(
      `There was an error when recognizing the application. Make sure you are in the root path of a Booster project:\n${e.message}`
    )
  }
}

export async function checkProjectAlreadyExists(name: string): Promise<void> {
  const projectDirectoryPath = projectDir({ projectName: name } as ProjectInitializerConfig)
  const projectDirectoryExists = existsSync(projectDirectoryPath)

  if (projectDirectoryExists) {
    await Prompter.confirmPrompt({
      message: Brand.dangerize(`Project folder "${name}" already exists. Do you want to overwrite it?`),
    }).then((confirm) => {
      if (!confirm) throw new Error("The folder you're trying to use already exists. Please use another project name")
      removeSync(projectDirectoryPath)
    })
  }
}

export async function checkResourceExists(name: string, placementDir: string, extension: string): Promise<void> {
  const resourcePath = filePath({ name, placementDir, extension })
  const resourceExists = existsSync(resourcePath)
  const resourceName = classNameToFileName(name)
  const resourceType = getResourceType(placementDir)

  oraLogger.info(Brand.mellancholize('Checking if resource already exists...'))

  if (resourceExists) {
    await Prompter.confirmPrompt({
      message: Brand.dangerize(`Resource: "${resourceName}${extension}" already exists. Do you want to overwrite it?`),
    }).then((confirm) => {
      if (!confirm)
        throw new Error(
          `The '${resourceType}' resource "${resourceName}${extension}" already exists. Please use another resource name`
        )
      removeSync(resourcePath)
    })
  }
}
