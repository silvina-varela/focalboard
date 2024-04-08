// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import * as fs from "fs"
import minimist from "minimist"
import { exit } from "process"
import { ArchiveUtils } from "../util/archive"
import { Block } from "../../webapp/src/blocks/block"
import { Board } from "../../webapp/src/blocks/board"
import { IPropertyOption, IPropertyTemplate, createBoard, } from "../../webapp/src/blocks/board"
import { createBoardView } from "../../webapp/src/blocks/boardView"
import { createCard } from "../../webapp/src/blocks/card"
import { createTextBlock } from "../../webapp/src/blocks/textBlock"
import { createCheckboxBlock } from "../../webapp/src/blocks/checkboxBlock"
import { Trello } from "./trello"
import { Utils } from "./utils"
import { createCommentBlock } from "../../webapp/src/blocks/commentBlock"

// HACKHACK: To allow Utils.CreateGuid to work
(global.window as any) = {}

type TrelloUsersType = {
    id: string;
    idTrello: string;
    username: string;
}

const optionColors = [
    // 'propColorDefault',
    "propColorGray",
    "propColorBrown",
    "propColorOrange",
    "propColorYellow",
    "propColorGreen",
    "propColorBlue",
    "propColorPurple",
    "propColorPink",
    "propColorRed",
]
let optionColorIndex = 0
let labelOptionColorIndex = 0

function main() {
    const args: minimist.ParsedArgs = minimist(process.argv.slice(2))

    const inputFile = args["i"]
    const outputFile = args["o"] || "archive.boardarchive"
    const users = args["u"] || []
    const teamId = args["t"] || ""
    const channelId = args["c"] || ""

    if (!inputFile) {
        showHelp()
    }

    if (!fs.existsSync(inputFile)) {
        console.error(`File not found: ${inputFile}`)
        exit(2)
    }

    // Read input
    const inputData = fs.readFileSync(inputFile, "utf-8")
    const input = JSON.parse(inputData) as Trello

    const trelloUsers = fs.readFileSync(users, "utf-8")
    // Convert
    const [boards, blocks] = convert(input, teamId, channelId, JSON.parse(trelloUsers))

    // Save output
    // TODO: Stream output
    const outputData = ArchiveUtils.buildBlockArchive(boards, blocks)
    fs.writeFileSync(outputFile, outputData)

    console.log(`Exported to ${outputFile}`)
}

function convert(
    input: Trello,
    teamId: string,
    channelId: string,
    trelloUsers: TrelloUsersType[]
): [Board[], Block[]] {
    const boards: Board[] = []
    const blocks: Block[] = []

    // Board
    const board = createBoard()
    console.log(`Board: ${input.name}`)
    board.title = input.name
    board.description = input.desc
    board.teamId = teamId
    board.channelId = channelId

    // Convert lists (columns) to a Select property
    const optionIdMap = new Map<string, string>()
    const options: IPropertyOption[] = []
    input.lists.forEach((list) => {
        const optionId = Utils.createGuid()
        optionIdMap.set(list.id, optionId)
        const color = optionColors[optionColorIndex % optionColors.length]
        optionColorIndex += 1
        const option: IPropertyOption = {
            id: optionId,
            value: list.name,
            color,
        }
        options.push(option)
    })

    const cardProperty: IPropertyTemplate = {
        id: Utils.createGuid(),
        name: "List",
        type: "select",
        options,
    }

    // Convert members to assignee property
    const assigneesProperty: IPropertyTemplate = {
        id: Utils.createGuid(),
        name: "Assignees",
        type: "multiPerson",
        options: [],
    }

    // Convert labels to a Multiselect property
    const labelsIdMap = new Map<string, string>()
    const labelsOptions: IPropertyOption[] = []
    input.labels.forEach((label) => {
        const optionId = Utils.createGuid()
        labelsIdMap.set(label.id, optionId)
        const color = optionColors[labelOptionColorIndex % optionColors.length]
        labelOptionColorIndex += 1
        const option: IPropertyOption = {
            id: optionId,
            value: label.name,
            color,
        }
        labelsOptions.push(option)
    })

    const labelProperty: IPropertyTemplate = {
        id: Utils.createGuid(),
        name: "Labels",
        type: "multiSelect",
        options: labelsOptions,
    }

    board.cardProperties = [cardProperty, assigneesProperty, labelProperty]

    boards.push(board)

    // Board view
    const view = createBoardView()
    view.title = "Board View"
    view.fields.viewType = "board"
    view.boardId = board.id
    view.parentId = board.id
    blocks.push(view)

    // Cards
    input.cards.forEach((card) => {
    // console.log(`Card: ${card.name}`)

        const outCard = createCard()
        outCard.title = card.name
        outCard.boardId = board.id
        outCard.parentId = board.id

        // Map lists to Select property options
        if (card.idList) {
            const optionId = optionIdMap.get(card.idList)
            if (optionId) {
                outCard.fields.properties[cardProperty.id] = optionId
            } else {
                console.warn(`Invalid idList: ${card.idList} for card: ${card.name}`)
            }
        } else {
            console.warn(`Missing idList for card: ${card.name}`)
        }

        if (card.idMembers?.length) {
            const members: string[] = []
            card.idMembers.forEach((member) => {
                const mattermostUser = trelloUsers.find(
                    (user) => member === user.idTrello
                )
                if (mattermostUser) {
                    members.push(mattermostUser.id)
                }
            })
            outCard.fields.properties[assigneesProperty.id] = members
        }

        if (card.idLabels?.length) {
            const labels: string[] = []
            card.idLabels.forEach((idLabel) => {
                const labelOptionId = labelsIdMap.get(idLabel)
                if (labelOptionId) {
                    labels.push(labelOptionId)
                }
            })
            outCard.fields.properties[labelProperty.id] = labels
        }

        blocks.push(outCard)

        if (card.desc) {
            // console.log(`\t${card.desc}`)
            const text = createTextBlock()
            text.title = card.desc
            text.boardId = board.id
            text.parentId = outCard.id
            blocks.push(text)

            outCard.fields.contentOrder = [text.id]
        }

        // Add Checklists
        if (card.idChecklists && card.idChecklists.length > 0) {
            card.idChecklists.forEach((checklistID) => {
                const lookup = input.checklists.find((e) => e.id === checklistID)
                if (lookup) {
                    lookup.checkItems.forEach((trelloCheckBox) => {
                        const checkBlock = createCheckboxBlock()
                        checkBlock.title = trelloCheckBox.name
                        if (trelloCheckBox.state === "complete") {
                            checkBlock.fields.value = true
                        } else {
                            checkBlock.fields.value = false
                        }
                        checkBlock.boardId = board.id
                        checkBlock.parentId = outCard.id
                        blocks.push(checkBlock)

                        outCard.fields.contentOrder.push(checkBlock.id)
                    })
                }
            })
        }

        // Add Comments
        if (card.badges.comments) {
            const comments = input.actions.filter(
                (action) =>
                    action.type === "commentCard" && action.data.card?.id === card.id
            )
            if (comments.length) {
                comments.forEach((comment) => {
                    const commentBlock = createCommentBlock()

                    const trelloUser = comment.idMemberCreator
                    const mattermostUser = trelloUsers.find(
                        (user) => trelloUser === user.idTrello
                    )

                    const username = mattermostUser?.username ? `**@${mattermostUser.username}:** ` : ""

                    const commentText = comment.data.text ?? ""

                    commentBlock.title =  username ? username + commentText : commentText
                    commentBlock.boardId = board.id
                    commentBlock.parentId = outCard.id

                    if (mattermostUser) {
                        commentBlock.createdBy = mattermostUser.id
                        commentBlock.modifiedBy = mattermostUser.id
                        commentBlock.updateAt = new Date(comment.date).getTime()
                    }
                    blocks.push(commentBlock)
                })
            }
        }
    })

    console.log("")
    console.log(`Found ${input.cards.length} card(s).`)

    return [boards, blocks]
}

function showHelp() {
    console.log("import -i <input.json> -o [output.boardarchive]")
    exit(1)
}

main()
